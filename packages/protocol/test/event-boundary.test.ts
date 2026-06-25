import { expect, test } from "bun:test"
import { EventManifest } from "@opencode-ai/schema/event-manifest"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { EventGroup } from "../src/groups/event"

const currentOpenApi = OpenApi.fromApi(HttpApi.make("test").add(EventGroup))
const currentEventOpenApi = JSON.stringify(currentOpenApi.components.schemas?.V2Event)

test("current Protocol events exclude V1-only session events", () => {
  const current = new Set<string>(EventManifest.CurrentServerDefinitions.map((definition) => definition.type))
  const v1Only = SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined).map(
    (definition) => definition.type,
  )

  expect(v1Only).toEqual([
    "session.created",
    "session.updated",
    "session.deleted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ])
  expect(v1Only.filter((type) => current.has(type))).toEqual([])
  expect(current.has("session.next.prompted")).toBe(true)
  expect(current.has("permission.v2.asked")).toBe(true)
  expect(current.has("question.v2.asked")).toBe(true)
  expect(current.has("command.executed")).toBe(false)
  expect(currentEventOpenApi).toContain("session.next.prompted")
  expect(currentEventOpenApi).not.toContain("message.updated")
  expect(currentEventOpenApi).not.toContain("message.part.updated")
})

test("compatibility server inventory retains V1 events", () => {
  const compatibility = new Set(EventManifest.ServerDefinitions.map((definition) => definition.type))

  expect(compatibility.has("session.created")).toBe(true)
  expect(compatibility.has("message.updated")).toBe(true)
  expect(compatibility.has("message.part.updated")).toBe(true)
})
