import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ToolOutputRepository } from "@/tool/output-repository"
import { select } from "@/tool/output-repository"
import { ToolOutputTool } from "@/tool/output"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import path from "path"
import fs from "fs/promises"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    ToolOutputRepository.defaultLayer,
    Truncate.defaultLayer,
    FSUtil.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
  ),
)

describe("ToolOutputRepository", () => {
  it.instance("loads an untruncated bash result only from its owning session", () =>
    Effect.gen(function* () {
      const repository = yield* ToolOutputRepository.Service
      const owner = yield* seed({ callID: "call-owned", output: "first\nsecond", truncated: false })
      const other = yield* (yield* Session.Service).create({ title: "other" })

      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-owned",
          limit: 100,
          maxBytes: 50 * 1024,
        }),
      ).toEqual({
        status: "found",
        source: "sqlite",
        complete: true,
        selection: {
          output: "1: first\n2: second",
          summary: "Showing lines 1-2 of 2.",
          returned: 2,
          total: 2,
          more: false,
        },
      })
      expect(
        yield* repository.load({ sessionID: other.id, callID: "call-owned", limit: 100, maxBytes: 50 * 1024 }),
      ).toEqual({ status: "not_found" })
    }),
  )

  it.instance("loads a managed artifact and falls back to the SQLite preview after deletion", () =>
    Effect.gen(function* () {
      const repository = yield* ToolOutputRepository.Service
      const truncate = yield* Truncate.Service
      const fs = yield* FSUtil.Service
      const file = yield* truncate.write("full\nartifact\ncontent")
      yield* Effect.addFinalizer(() => fs.remove(file).pipe(Effect.catch(() => Effect.void)))
      const owner = yield* seed({
        callID: "call-artifact",
        output: "...output truncated...\n\npreview tail",
        truncated: true,
        outputPath: file,
      })

      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-artifact",
          limit: 100,
          maxBytes: 50 * 1024,
        }),
      ).toEqual({
        status: "found",
        source: "artifact",
        complete: true,
        selection: {
          output: "1: full\n2: artifact\n3: content",
          summary: "Showing lines 1-3 of 3.",
          returned: 3,
          total: 3,
          more: false,
        },
      })

      yield* fs.remove(file)
      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-artifact",
          limit: 100,
          maxBytes: 50 * 1024,
        }),
      ).toEqual({
        status: "found",
        source: "preview",
        complete: false,
        selection: {
          output: "1: ...output truncated...\n2: \n3: preview tail",
          summary: "Showing lines 1-3 of 3.",
          returned: 3,
          total: 3,
          more: false,
        },
      })
    }),
  )

  it.instance("rejects duplicate callIDs within one session", () =>
    Effect.gen(function* () {
      const repository = yield* ToolOutputRepository.Service
      const owner = yield* seed({ callID: "call-duplicate", output: "first", truncated: false })
      yield* addPart({
        sessionID: owner.sessionID,
        messageID: owner.messageID,
        callID: "call-duplicate",
        output: "second",
        truncated: false,
      })

      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-duplicate",
          limit: 100,
          maxBytes: 50 * 1024,
        }),
      ).toEqual({ status: "unavailable", reason: "multiple bash results use this callID" })
    }),
  )

  it.instance("does not read an outputPath outside the managed artifact directory", () =>
    Effect.gen(function* () {
      const repository = yield* ToolOutputRepository.Service
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const file = path.join(test.directory, "outside.log")
      yield* fs.writeFileString(file, "must not be returned")
      const owner = yield* seed({
        callID: "call-outside",
        output: "safe SQLite preview",
        truncated: true,
        outputPath: file,
      })

      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-outside",
          limit: 100,
          maxBytes: 50 * 1024,
        }),
      ).toEqual({
        status: "found",
        source: "preview",
        complete: false,
        selection: {
          output: "1: safe SQLite preview",
          summary: "Showing lines 1-1 of 1.",
          returned: 1,
          total: 1,
          more: false,
        },
      })
    }),
  )

  if (process.platform !== "win32") {
    it.instance("does not follow a managed-directory symlink to an outside artifact", () =>
      Effect.gen(function* () {
        const repository = yield* ToolOutputRepository.Service
        const files = yield* FSUtil.Service
        const test = yield* TestInstance
        const outside = path.join(test.directory, "outside-symlink.log")
        const link = path.join(Truncate.DIR, `tool_symlink_${Date.now()}`)
        yield* files.ensureDir(Truncate.DIR)
        yield* files.writeFileString(outside, "must not cross the canonical boundary")
        yield* Effect.promise(() => fs.symlink(outside, link))
        yield* Effect.addFinalizer(() => files.remove(link).pipe(Effect.catch(() => Effect.void)))
        const owner = yield* seed({
          callID: "call-symlink",
          output: "safe symlink preview",
          truncated: true,
          outputPath: link,
        })

        expect(
          yield* repository.load({
            sessionID: owner.sessionID,
            callID: "call-symlink",
            limit: 100,
            maxBytes: 50 * 1024,
          }),
        ).toMatchObject({
          status: "found",
          source: "preview",
          complete: false,
          selection: { output: "1: safe symlink preview" },
        })
      }),
    )
  }

  it.instance("streams pattern selection from a multi-chunk artifact", () =>
    Effect.gen(function* () {
      const repository = yield* ToolOutputRepository.Service
      const truncate = yield* Truncate.Service
      const fs = yield* FSUtil.Service
      const content = Array.from({ length: 5_000 }, (_, index) =>
        index === 3_499 ? `line-${index + 1}-needle` : `line-${index + 1}-${"x".repeat(20)}`,
      ).join("\n")
      const file = yield* truncate.write(content)
      yield* Effect.addFinalizer(() => fs.remove(file).pipe(Effect.catch(() => Effect.void)))
      const owner = yield* seed({
        callID: "call-stream",
        output: "preview",
        truncated: true,
        outputPath: file,
      })

      expect(
        yield* repository.load({
          sessionID: owner.sessionID,
          callID: "call-stream",
          pattern: "needle",
          limit: 1,
          maxBytes: 1024,
        }),
      ).toMatchObject({
        status: "found",
        source: "artifact",
        complete: true,
        selection: {
          output: "3500: line-3500-needle",
          returned: 1,
          total: 1,
          more: false,
        },
      })
    }),
  )

  it.instance(
    "keeps tool_output inside low configured line and byte limits",
    () =>
      Effect.gen(function* () {
        const owner = yield* seed({
          callID: "call-bounded",
          output: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
          truncated: false,
        })
        const info = yield* ToolOutputTool
        const tool = yield* Tool.init(info)
        const agent = yield* Agent.Service
        const result = yield* tool.execute(
          { callID: "call-bounded" },
          {
            sessionID: owner.sessionID,
            messageID: owner.messageID,
            agent: (yield* agent.defaultInfo()).name,
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output.split("\n").length).toBeLessThanOrEqual(2)
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(128)
        expect(result.output).toContain("none fit the configured output budget")
        expect(result.metadata).toMatchObject({ more: true, truncated: false })
      }),
    { config: { tool_output: { max_lines: 2, max_bytes: 128 } } },
  )
})

describe("tool_output selection", () => {
  test("returns a bounded line range with source line numbers", () => {
    expect(select("one\ntwo\nthree\nfour", { offset: 2, limit: 2, maxBytes: 50 * 1024 })).toEqual({
      output: "2: two\n3: three",
      summary: "Showing lines 2-3 of 4.",
      returned: 2,
      total: 4,
      more: true,
    })
  })

  test("filters with a pattern before applying offset and limit", () => {
    expect(
      select("info\nerror one\nignore\nerror two", {
        pattern: "error",
        offset: 2,
        limit: 1,
        maxBytes: 50 * 1024,
      }),
    ).toEqual({
      output: "4: error two",
      summary: "Showing matches 2-2 of 2.",
      returned: 1,
      total: 2,
      more: false,
    })
  })

  test("treats pattern as a literal substring and bounds output bytes", () => {
    expect(select("(a+)+$\naaaaa", { pattern: "(a+)+$", limit: 10, maxBytes: 100 })).toMatchObject({
      output: "1: (a+)+$",
      returned: 1,
      total: 1,
    })
    const selected = select("x".repeat(1000), { limit: 10, maxBytes: 100 })
    expect(Buffer.byteLength(selected.output, "utf-8")).toBeLessThanOrEqual(100)
    expect(selected.more).toBe(true)
  })
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const seed = Effect.fn("ToolOutputRepositoryTest.seed")(function* (input: {
  callID: string
  output: string
  truncated: boolean
  outputPath?: string
}) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: input.callID })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  yield* addPart({
    sessionID: chat.id,
    messageID: assistant.id,
    ...input,
  })
  return { sessionID: chat.id, messageID: assistant.id }
})

const addPart = Effect.fn("ToolOutputRepositoryTest.addPart")(function* (input: {
  sessionID: SessionV1.ToolPart["sessionID"]
  messageID: SessionV1.ToolPart["messageID"]
  callID: string
  output: string
  truncated: boolean
  outputPath?: string
}) {
  const session = yield* Session.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    tool: "bash",
    callID: input.callID,
    state: {
      status: "completed",
      input: { command: "test" },
      output: input.output,
      title: "test",
      metadata: {
        exit: 0,
        termination: "exit",
        truncated: input.truncated,
        ...(input.outputPath ? { outputPath: input.outputPath } : {}),
      },
      time: { start: Date.now(), end: Date.now() },
    },
  })
})
