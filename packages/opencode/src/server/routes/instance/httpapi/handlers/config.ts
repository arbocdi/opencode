import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderContextLimit } from "@/provider/context-limit"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const config = yield* configSvc.get()
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map((item) =>
          ProviderContextLimit.withUsable({
            cfg: config,
            provider: Provider.toPublicInfo(item),
            outputTokenMax: flags.outputTokenMax,
          }),
        ),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
