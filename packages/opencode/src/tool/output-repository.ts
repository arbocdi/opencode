import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Stream } from "effect"
import path from "path"
import { SessionID } from "@/session/schema"
import { TRUNCATION_DIR } from "./truncation-dir"

export type Result =
  | {
      status: "found"
      source: "sqlite" | "artifact" | "preview"
      complete: boolean
      selection: Selection
    }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string }

export type Selection = {
  output: string
  summary: string
  returned: number
  total: number
  more: boolean
}

type LoadInput = {
  sessionID: SessionID
  callID: string
  offset?: number
  limit: number
  pattern?: string
  maxBytes: number
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutputRepository") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service

    const load = Effect.fn("ToolOutputRepository.load")(function* (input: LoadInput) {
      const rows = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
            sql`json_extract(${PartTable.data}, '$.tool') = 'bash'`,
            sql`json_extract(${PartTable.data}, '$.callID') = ${input.callID}`,
          ),
        )
        .limit(2)
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return { status: "not_found" } as const
      if (rows.length > 1) {
        return { status: "unavailable", reason: "multiple bash results use this callID" } as const
      }

      const row = rows[0]!
      const part = row.data as SessionV1.Part
      if (part.type !== "tool" || part.tool !== "bash" || part.callID !== input.callID) {
        return { status: "not_found" } as const
      }
      if (part.state.status !== "completed") {
        return { status: "unavailable", reason: `bash result status is ${part.state.status}` } as const
      }
      if (part.state.metadata.truncated !== true) {
        return {
          status: "found",
          source: "sqlite",
          complete: true,
          selection: select(part.state.output, input),
        } as const
      }

      const outputPath = part.state.metadata.outputPath
      if (typeof outputPath === "string") {
        const paths = yield* Effect.all({
          root: fs.realPath(TRUNCATION_DIR),
          file: fs.realPath(outputPath),
        }).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<{ root: string; file: string }>())),
        )
        if (Option.isSome(paths) && managed(paths.value.root, paths.value.file)) {
          const selection = yield* selectFile(fs, paths.value.file, input).pipe(
            Effect.map(Option.some),
            Effect.catch(() => Effect.succeed(Option.none<Selection>())),
          )
          if (Option.isSome(selection)) {
            return { status: "found", source: "artifact", complete: true, selection: selection.value } as const
          }
        }
      }

      return {
        status: "found",
        source: "preview",
        complete: false,
        selection: select(part.state.output, input),
      } as const
    })

    return Service.of({ load })
  }),
)

function managed(root: string, file: string) {
  const relative = path.relative(root, file)
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    path.basename(file).startsWith("tool_")
  )
}

function selectFile(
  fs: FSUtil.Interface,
  file: string,
  input: { offset?: number; limit: number; pattern?: string; maxBytes: number },
) {
  return Effect.gen(function* () {
    const collector = collect(input)
    const decoder = new TextDecoder("utf-8")
    let line = 0
    yield* fs.stream(file).pipe(
      Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
      Stream.splitLines,
      Stream.runForEach((text) => Effect.sync(() => collector.add(text, ++line))),
    )
    return collector.done()
  })
}

export function select(
  content: string,
  input: { offset?: number; limit: number; pattern?: string; maxBytes: number },
) {
  const collector = collect(input)
  content.split(/\r?\n/).forEach((line, index) => collector.add(line, index + 1))
  return collector.done()
}

function collect(input: { offset?: number; limit: number; pattern?: string; maxBytes: number }) {
  const offset = input.offset ?? 1
  const rows: string[] = []
  let total = 0
  let bytes = 0
  let cut = false
  return {
    add(line: string, number: number) {
      if (input.pattern && !line.includes(input.pattern)) return
      total += 1
      if (total < offset) return
      if (rows.length >= input.limit) {
        cut = true
        return
      }
      const row = `${number}: ${clip(line)}`
      const size = Buffer.byteLength(row, "utf-8") + (rows.length > 0 ? 1 : 0)
      if (bytes + size > input.maxBytes) {
        cut = true
        return
      }
      rows.push(row)
      bytes += size
    },
    done(): Selection {
      const label = input.pattern ? "matches" : "lines"
      const summary = rows.length
        ? `Showing ${label} ${offset}-${offset + rows.length - 1} of ${total}.`
        : cut && total >= offset
          ? `Returned 0 of ${total} ${label}; none fit the configured output budget.`
          : `No ${label} found at offset ${offset}.`
      return {
        output: rows.join("\n"),
        summary,
        returned: rows.length,
        total,
        more: cut || offset - 1 + rows.length < total,
      }
    },
  }
}

function clip(line: string) {
  const max = 2_000
  if (line.length <= max) return line
  return `${line.slice(0, max)}... (line truncated to ${max} chars)`
}

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [Database.node, FSUtil.node])

export * as ToolOutputRepository from "./output-repository"
