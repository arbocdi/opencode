import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ToolResultContextProjector } from "@/session/tool-result-context"
import { MessageID, PartID, SessionID } from "@/session/schema"

describe("ToolResultContextProjector", () => {
  test("projects a successful bash result with a short tail", () => {
    const output = `${"old".repeat(200)}\nlast line`
    const result = ToolResultContextProjector.project(part({ output, exit: 0, termination: "exit" }))

    expect(result).toContain("Command: git diff --check")
    expect(result).toContain("Workdir: /repo")
    expect(result).toContain("Result: succeeded")
    expect(result).toContain("Exit code: 0")
    expect(result).toContain("last line")
    expect(result).not.toContain(output)
    expect(result).toContain("Historical output: tool-result://call-bash")
  })

  test("keeps a larger diagnostic tail for nonzero exit", () => {
    const diagnostic = "failure context ".repeat(60)
    const result = ToolResultContextProjector.project(part({ output: diagnostic, exit: 1, termination: "exit" }))

    expect(result).toContain("Result: failed")
    expect(result).toContain("Exit code: 1")
    expect(result).toContain(diagnostic.trim())
  })

  test("bounds command and workdir details", () => {
    const result = ToolResultContextProjector.project(
      part({
        output: "complete",
        exit: 0,
        termination: "exit",
        command: "x".repeat(400),
        workdir: `/${"x".repeat(400)}`,
      }),
    )

    expect(result).toContain("command chars omitted]")
    expect(result).toContain("workdir chars omitted]")
  })

  test("labels timeout and abort for current and historical metadata", () => {
    expect(ToolResultContextProjector.project(part({ output: "partial", exit: null, termination: "timeout" }))).toContain(
      "Result: timed out",
    )
    expect(
      ToolResultContextProjector.project(
        part({ output: "partial\n<shell_metadata>\nUser aborted the command\n</shell_metadata>", exit: null }),
      ),
    ).toContain("Result: aborted")
  })

  test("keeps the generic marker for tools without a specialized policy", () => {
    const input = part({ output: "secret", exit: 0, termination: "exit" })
    input.tool = "read"

    expect(ToolResultContextProjector.project(input)).toBe("[Old tool result content cleared]")
  })
})

function part(input: {
  output: string
  exit: number | null
  termination?: "exit" | "timeout" | "abort"
  command?: string
  workdir?: string
}) {
  return {
    id: PartID.make("prt_bash"),
    sessionID: SessionID.make("ses_bash"),
    messageID: MessageID.make("msg_bash"),
    type: "tool",
    callID: "call-bash",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: input.command ?? "git diff --check", workdir: input.workdir ?? "/repo" },
      output: input.output,
      title: "git diff --check",
      metadata: { exit: input.exit, termination: input.termination, truncated: false },
      time: { start: 1, end: 2, compacted: 3 },
    },
  } satisfies SessionV1.ToolPart
}
