import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const GlobalEventData = Schema.Struct({
  directory: Schema.optional(Schema.String),
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.String,
    properties: Schema.Record(Schema.String, Schema.Any),
  }),
})
type GlobalEventData = Schema.Schema.Type<typeof GlobalEventData>

const readEvent = (reader: Queue.Dequeue<GlobalEventData>) =>
  Queue.take(reader).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for global event")),
    }),
  )

const consume = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const reader = yield* Queue.unbounded<GlobalEventData>()
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decodeDataSchema(GlobalEventData)),
      Stream.runForEach((event) => Queue.offer(reader, event.data)),
      Effect.forkScoped,
    )
    return reader
  })

const openEventStream = Effect.gen(function* () {
  const response = yield* HttpClient.get(GlobalPaths.event)
  return { response, reader: yield* consume(response) }
})

describe("global HttpApi", () => {
  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )

  it.live("broadcasts events to simultaneous subscribers", () =>
    Effect.gen(function* () {
      const first = yield* openEventStream
      const second = yield* openEventStream
      expect(yield* readEvent(first.reader)).toMatchObject({ payload: { type: "server.connected" } })
      expect(yield* readEvent(second.reader)).toMatchObject({ payload: { type: "server.connected" } })

      GlobalBus.emit("event", {
        directory: "/repo",
        payload: { type: "test.event", properties: { value: "broadcast" } },
      })

      expect(yield* readEvent(first.reader)).toMatchObject({
        directory: "/repo",
        payload: { type: "test.event", properties: { value: "broadcast" } },
      })
      expect(yield* readEvent(second.reader)).toMatchObject({
        directory: "/repo",
        payload: { type: "test.event", properties: { value: "broadcast" } },
      })
    }),
  )

  it.live("subscribes before the response body starts", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(GlobalPaths.event)
      GlobalBus.emit("event", {
        directory: "/repo",
        payload: { type: "test.event", properties: { value: "queued" } },
      })
      const reader = yield* consume(response)

      expect(yield* readEvent(reader)).toMatchObject({ payload: { type: "server.connected" } })
      expect(yield* readEvent(reader)).toMatchObject({
        directory: "/repo",
        payload: { type: "test.event", properties: { value: "queued" } },
      })
    }),
  )
})
