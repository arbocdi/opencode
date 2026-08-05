import { SessionV1 } from "@opencode-ai/core/v1/session"

const CLEARED = "[Old tool result content cleared]"
const COMMAND_MAX_CHARS = 300
const WORKDIR_MAX_CHARS = 300
const SUCCESS_TAIL_MAX_CHARS = 300
const DIAGNOSTIC_TAIL_MAX_CHARS = 1_200

export function project(part: SessionV1.ToolPart) {
  if (part.tool !== "bash" || part.state.status !== "completed") return CLEARED

  const command = text(part.state.input.command) ?? part.state.title
  const workdir = text(part.state.input.workdir) ?? "session directory"
  const exit = number(part.state.metadata.exit)
  const result = resultLabel(part.state.metadata.termination, exit, part.state.output)
  const diagnostic = result !== "succeeded"
  const recent = tail(part.state.output, diagnostic ? DIAGNOSTIC_TAIL_MAX_CHARS : SUCCESS_TAIL_MAX_CHARS)
  return [
    "Tool bash completed.",
    `Command: ${head(command, COMMAND_MAX_CHARS, "command")}`,
    `Workdir: ${head(workdir, WORKDIR_MAX_CHARS, "workdir")}`,
    `Result: ${result}`,
    `Exit code: ${exit ?? "unavailable"}`,
    `Original output truncated: ${part.state.metadata.truncated === true ? "yes" : "no"}`,
    recent && recent !== "(no output)" ? `Recent output:\n${recent}` : undefined,
    `Historical output: tool-result://${part.callID}`,
    `Use tool_output with callID "${part.callID}" and offset/limit or pattern to inspect details.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function resultLabel(termination: unknown, exit: number | undefined, output: string) {
  if (termination === "timeout") return "timed out"
  if (termination === "abort") return "aborted"
  if (termination === "exit") return exit === 0 ? "succeeded" : exit === undefined ? "unknown" : "failed"
  if (exit === 0) return "succeeded"
  if (exit !== undefined) return "failed"
  const metadata = output.match(/<shell_metadata>\s*([\s\S]*?)\s*<\/shell_metadata>/)?.[1] ?? ""
  if (metadata.includes("User aborted the command")) return "aborted"
  if (metadata.includes("shell tool terminated command after exceeding timeout")) return "timed out"
  return "unknown"
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function head(value: string, max: number, label: string) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n[...${value.length - max} ${label} chars omitted]`
}

function tail(value: string, max: number) {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `[...${trimmed.length - max} output chars omitted]\n${trimmed.slice(-max)}`
}

export * as ToolResultContextProjector from "./tool-result-context"
