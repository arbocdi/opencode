import { PositiveInt } from "@opencode-ai/core/schema"
import { Effect, Schema } from "effect"
import DESCRIPTION from "./output.txt"
import { ToolOutputRepository } from "./output-repository"
import { Tool } from "./tool"
import { Truncate } from "./truncate"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const HEADER_BUDGET = 256

export const Parameters = Schema.Struct({
  callID: Schema.String.annotate({ description: "The callID shown in a historical tool result projection" }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "1-indexed source line or matching-result offset. Defaults to 1.",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: `Maximum lines or matches to return. Defaults to ${DEFAULT_LIMIT} and is capped at ${MAX_LIMIT}.`,
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "Optional case-sensitive literal substring. When set, returns matching source lines with line numbers.",
  }),
})

type Parameters = Schema.Schema.Type<typeof Parameters>
type Metadata = {
  callID: string
  complete: boolean
  source: "sqlite" | "artifact" | "preview" | "missing" | "unavailable"
  returned?: number
  total?: number
  more?: boolean
}

export const ToolOutputTool = Tool.define<
  typeof Parameters,
  Metadata,
  ToolOutputRepository.Service | Truncate.Service
>(
  "tool_output",
  Effect.gen(function* () {
    const repository = yield* ToolOutputRepository.Service
    const truncate = yield* Truncate.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const limits = yield* truncate.limits()
          const result = yield* repository.load({
            sessionID: ctx.sessionID,
            callID: params.callID,
            offset: params.offset,
            limit: Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT, Math.max(0, limits.maxLines - 1)),
            pattern: params.pattern,
            maxBytes: Math.max(0, limits.maxBytes - Math.min(HEADER_BUDGET, limits.maxBytes) - 1),
          })
          if (result.status === "not_found") {
            return {
              title: "Historical bash output not found",
              output: `No bash result with callID "${params.callID}" exists in the current session.`,
              metadata: { callID: params.callID, complete: false, source: "missing" as const },
            }
          }
          if (result.status === "unavailable") {
            return {
              title: "Historical bash output unavailable",
              output: `The bash result with callID "${params.callID}" cannot be loaded: ${result.reason}.`,
              metadata: { callID: params.callID, complete: false, source: "unavailable" as const },
            }
          }

          const selected = result.selection
          const header = bounded(
            `${selected.summary} Historical bash output callID="${params.callID}"; source=${result.source}; complete=${result.complete ? "yes" : "no"}.`,
            Math.min(HEADER_BUDGET, limits.maxBytes),
          )
          return {
            title: `Historical bash output ${params.callID}`,
            output: [header, selected.output].filter(Boolean).join("\n"),
            metadata: {
              callID: params.callID,
              complete: result.complete,
              source: result.source,
              returned: selected.returned,
              total: selected.total,
              more: selected.more,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function bounded(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf-8")
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString("utf-8")
}
