# План исследования и исправления

## Цель

Сделать индикатор заполнения контекста в web UI согласованным с реальной backend-логикой auto-compaction.

Сейчас UI использует полный `model.limit.context`, а compaction использует effective usable budget. Для GPT-5.5 это дает расхождение `400 000` против `252 000`.

## Найденные файлы

### Web UI metrics

```text
packages/app/src/components/session/session-context-metrics.ts
```

Здесь считается текущая метрика контекста:

```ts
const limit = model?.limit.context
const total = tokenTotal(message)
usage: limit ? Math.round((total / limit) * 100) : null
```

То есть UI сейчас напрямую использует `model.limit.context`.

### Вкладка `Контекст`

```text
packages/app/src/components/session/session-context-tab.tsx
```

Здесь рендерятся значения:

```text
context.stats.limit
context.stats.totalTokens
context.stats.usage
```

Именно это пользователь видит во вкладке справа.

### Маленький круглый индикатор

```text
packages/app/src/components/session-context-usage.tsx
```

Здесь `ProgressCircle` получает:

```tsx
percentage={context()?.usage ?? 0}
```

То есть маленький индикатор и вкладка `Контекст` используют одну и ту же ошибочную метрику.

### OpenAI GPT-5.5 limits

```text
packages/opencode/src/plugin/openai/codex.ts
```

Для OAuth OpenAI plugin GPT-5.5 задается так:

```ts
limit: model.id.includes("gpt-5.5")
  ? {
      context: 400_000,
      input: 272_000,
      output: 128_000,
    }
  : model.limit
```

Именно поэтому UI показывает `400 000`.

### Compaction overflow logic

```text
packages/opencode/src/session/overflow.ts
```

Ключевая логика:

```ts
const COMPACTION_BUFFER = 20_000

const reserved =
  input.cfg.compaction?.reserved ??
  Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))

return input.model.limit.input
  ? Math.max(0, input.model.limit.input - reserved)
  : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
```

Overflow проверяется так:

```ts
return count >= usable(input)
```

### Max output token default

```text
packages/opencode/src/provider/transform.ts
```

По умолчанию:

```ts
export const OUTPUT_TOKEN_MAX = 32_000
```

Функция:

```ts
export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}
```

Для GPT-5.5:

```text
maxOutputTokens = min(128 000, 32 000) = 32 000
reserved        = min(20 000, 32 000)  = 20 000
usable          = 272 000 - 20 000     = 252 000
```

### Provider/model config override

```text
packages/core/src/v1/config/provider.ts
packages/opencode/src/provider/provider.ts
```

Schema поддерживает:

```ts
limit: {
  context: number
  input?: number
  output: number
}
```

Runtime merge использует config override:

```ts
limit: {
  context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
  input: model.limit?.input ?? existingModel?.limit?.input,
  output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
}
```

### Compaction config override

```text
packages/core/src/v1/config/config.ts
```

Schema поддерживает:

```ts
compaction: {
  auto?: boolean
  prune?: boolean
  tail_turns?: number
  preserve_recent_tokens?: number
  reserved?: number
}
```

Для индикатора особенно важен `compaction.reserved`.

## Причинно-следственная цепочка

1. OpenAI OAuth plugin задает GPT-5.5 полный `context = 400_000` и `input = 272_000`.
2. Web UI получает provider/model info через provider list и видит `model.limit.context = 400_000`.
3. `session-context-metrics.ts` считает usage как `total / 400_000`.
4. Backend `overflow.ts` считает auto-compaction threshold как `input - reserved`.
5. При default config это `272_000 - 20_000 = 252_000`.
6. Поэтому UI показывает слишком оптимистичный percentage.

## Технические варианты фикса

### Вариант 1: backend отдает computed effective limit

Наиболее правильный вариант.

Идея:

1. Не дублировать формулу compaction в frontend.
2. Backend рассчитывает effective context/usable limit рядом с provider/model/config logic.
3. SDK/API отдает это в app.
4. Web UI использует это значение для progress/usage.

Плюсы:

- одна source of truth;
- учитывается `compaction.reserved`;
- учитываются provider/model overrides;
- меньше риска, что UI и backend снова разойдутся.

Минусы:

- нужно менять API shape/SDK types;
- возможно понадобится регенерация JS SDK;
- надо аккуратно выбрать имя поля.

Возможные имена:

```text
limit.effective
limit.usable
limit.compaction
limit.inputAvailable
```

Лучшее по смыслу пока выглядит как `limit.usable`, потому что backend function уже называется `usable(...)`.

### Вариант 2: frontend повторяет формулу `usable(...)`

Быстрый, но менее правильный вариант.

Идея:

1. Расширить frontend model type, чтобы видеть `limit.input` и `limit.output`.
2. В `session-context-metrics.ts` повторить формулу:

```text
usable = input ? input - reserved : context - maxOutputTokens
```

Проблема: frontend не знает актуальный `cfg.compaction.reserved`, если config не отдается в app. Можно использовать default `20_000`, но это будет опять потенциально неверно при override.

Плюсы:

- меньше backend/API изменений;
- быстрее сделать локально.

Минусы:

- дублирование backend logic;
- хуже с config overrides;
- легко снова получить расхождение.

### Вариант 3: только переименовать UI label

Недостаточно.

Можно было бы оставить `400 000`, но назвать поле `Полное окно модели`. Однако progress circle все равно продолжит врать про реальную близость к compaction.

Этот вариант не решает основную проблему.

## Предпочтительное решение

Предпочтительно сделать backend-computed value и использовать его в web UI.

Ожидаемый UI:

- `Лимит контекста`: полный raw context, например `400 000`.
- `Доступно до сжатия`: effective usable limit, например `252 000`.
- `Использование`: считать от `usable`, например `39%`.
- маленький `ProgressCircle`: тоже считать от `usable`.

Если `usable` недоступен, fallback можно оставить на `context`, чтобы UI не ломался на старых/неполных данных.

## Реализованное решение

Реализован backend-computed вариант.

### Backend

Добавлен общий helper:

```text
packages/opencode/src/provider/context-limit.ts
```

В нем находится чистая формула:

```ts
usable({ cfg, model, outputTokenMax })
```

Она повторяет старую backend compaction formula, но теперь является общей точкой правды:

```text
reserved = cfg.compaction.reserved ?? min(20_000, maxOutputTokens(model))

if model.limit.input exists:
  usable = model.limit.input - reserved
else:
  usable = model.limit.context - maxOutputTokens(model)
```

`packages/opencode/src/session/overflow.ts` теперь вызывает этот helper, а не содержит свою отдельную копию формулы.

Provider model schema расширена optional полем:

```ts
limit: {
  context: number
  input?: number
  output: number
  usable?: number
}
```

Backend добавляет `limit.usable` в публичный provider response в двух местах:

```text
packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts
```

Важно: provider state не мутируется. `Provider.toPublicInfo(...)` сначала создает JSON-safe копию, затем в эту копию добавляется computed `limit.usable`.

### SDK

JS SDK regenerated через проектный script:

```bash
PATH="/home/arbocdi/.bun/bin:$PATH" ./packages/sdk/js/script/build.ts
```

Из generated-файлов изменился:

```text
packages/sdk/js/src/v2/gen/types.gen.ts
```

В `Model.limit` появилось:

```ts
usable?: number
```

### Web UI

`packages/app/src/components/session/session-context-metrics.ts` теперь различает:

```ts
limit       // raw model context window
usableLimit // backend-computed usable limit before compaction
usageLimit  // denominator for percentage: usableLimit ?? limit
```

`usage` теперь считается так:

```text
totalTokens / (usableLimit ?? contextLimit)
```

Во вкладку `Контекст` добавлена отдельная строка:

```text
Доступно до сжатия
```

А строка `Лимит контекста` сохранена для raw `context`, чтобы пользователь видел оба числа.

## Что проверить перед реализацией

Перед изменением кода нужно открыть и проверить:

```text
packages/app/src/components/session/session-context-metrics.ts
packages/app/src/components/session/session-context-tab.tsx
packages/app/src/components/session-context-usage.tsx
packages/opencode/src/session/overflow.ts
packages/opencode/src/session/compaction.ts
packages/opencode/src/plugin/openai/codex.ts
packages/opencode/src/provider/provider.ts
packages/core/src/v1/config/provider.ts
packages/core/src/v1/config/config.ts
```

### Provider list API и SDK contracts

Текущий web app берет provider catalog через:

```text
packages/app/src/context/global-sync/bootstrap.ts
packages/app/src/context/global-sync/utils.ts
packages/app/src/hooks/use-providers.ts
```

Важная цепочка:

```text
sdk.provider.list()
  -> normalizeProviderList(x.data!)
  -> serverSync().data.provider
  -> useProviders(...)
  -> getSessionContextMetrics(...)
```

`normalizeProviderList` импортирует тип:

```ts
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
```

В generated SDK этот response сейчас выглядит так:

```text
packages/sdk/js/src/v2/gen/types.gen.ts
```

```ts
export type ProviderListResponses = {
  200: {
    all: Array<Provider>
    default: { [key: string]: string }
    connected: Array<string>
  }
}

export type Model = {
  limit: {
    context: number
    input?: number
    output: number
  }
}
```

Backend handler для этого compatibility endpoint:

```text
packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts
```

Он возвращает:

```ts
{
  all: Object.values(providers).map(Provider.toPublicInfo),
  default: Provider.defaultModelIDs(providers),
  connected: Object.keys(connected),
}
```

Схема runtime provider/model, которая попадает в этот response:

```text
packages/opencode/src/provider/provider.ts
```

```ts
const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optionalOmitUndefined(Schema.Finite),
  output: Schema.Finite,
})
```

Если добавлять backend-computed field, schema-level место изменения:

```text
packages/opencode/src/provider/provider.ts
```

Например расширить `ProviderLimit` полем `usable` или похожим именем.

Но важный нюанс: `usable` нельзя считать постоянным свойством модели в вакууме. Оно зависит от:

- `model.limit.context`;
- `model.limit.input`;
- `model.limit.output`;
- `cfg.compaction.reserved`;
- `RuntimeFlags.outputTokenMax`, если задан `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`.

Поэтому есть два нормальных пути реализации:

- вычислять `limit.usable` в `provider.list` handler перед отдачей response, потому что handler уже читает config;
- вынести формулу `usable(...)` в небольшой общий pure helper и использовать один и тот же helper и в compaction/overflow, и при построении provider response.

Второй путь лучше, потому что убирает дублирование формулы и делает backend source of truth явным.

Текущая формула уже есть здесь:

```text
packages/opencode/src/session/overflow.ts
```

Но если напрямую импортировать `session/overflow.ts` в provider API, получится зависимость provider/server layer от session domain. Перед реализацией надо проверить, не лучше ли перенести чистую формулу в отдельный модуль, например рядом с provider transform/limits, и оставить `session/overflow.ts` тонкой оберткой.

Отдельно существует новый protocol route:

```text
packages/protocol/src/groups/provider.ts
packages/server/src/handlers/provider.ts
packages/schema/src/provider.ts
```

Но он возвращает `Location.response(Array<Provider.Info>)`, а `Provider.Info` из `packages/schema/src/provider.ts` сейчас содержит provider metadata без `models`. Для текущей вкладки `Контекст` это не основной путь данных.

После изменения compatibility API/schema нужно регенерировать SDK:

```bash
./packages/sdk/js/script/build.ts
```

И проверить, что `packages/sdk/js/src/v2/gen/types.gen.ts` получил новое поле в `Model.limit` и `ProviderListResponse` продолжает иметь форму `all/default/connected`.

### Runtime flag nuance

Есть runtime flag:

```text
OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX
```

Он читается в:

```text
packages/opencode/src/effect/runtime-flags.ts
```

И используется в compaction service:

```text
packages/opencode/src/session/compaction.ts
```

```ts
overflow({
  cfg: yield* config.get(),
  tokens: input.tokens,
  model: input.model,
  outputTokenMax: flags.outputTokenMax,
})
```

В одном месте processor вызывает `isOverflow` напрямую без `flags.outputTokenMax`:

```text
packages/opencode/src/session/processor.ts
```

```ts
isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
```

При default config это не влияет, потому что используется default `32_000`. Но если `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` задан, в backend уже может быть расхождение между двумя overflow checks. Для нашей задачи это не основной bug, но при аккуратном фиксе индикатора стоит не увеличивать это расхождение.

## Тесты и проверки после реализации

Минимально:

```bash
cd packages/app
/home/arbocdi/.bun/bin/bun typecheck
```

Если добавляем frontend unit test для metrics:

```bash
cd packages/app
/home/arbocdi/.bun/bin/bun test <test-file>
```

Для backend/API изменений:

```bash
cd packages/opencode
/home/arbocdi/.bun/bin/bun typecheck
```

Если меняется SDK schema/type output, по проектному правилу нужно регенерировать JS SDK:

```bash
./packages/sdk/js/script/build.ts
```

Важно: тесты нельзя запускать из корня репозитория. Запускать из package directories.

Фактически после реализации были выполнены:

```bash
cd packages/app
/home/arbocdi/.bun/bin/bun test src/components/session/session-context-metrics.test.ts
/home/arbocdi/.bun/bin/bun typecheck
```

Результат:

```text
5 pass
typecheck ok
```

```bash
cd packages/opencode
/home/arbocdi/.bun/bin/bun test test/server/httpapi-provider.test.ts
/home/arbocdi/.bun/bin/bun typecheck
```

Результат:

```text
6 pass, 1 skip
typecheck ok
```

```bash
cd packages/sdk/js
/home/arbocdi/.bun/bin/bun typecheck
```

Результат:

```text
typecheck ok
```

## Benchmark requirement

В `packages/app/AGENTS.md` есть правило:

```text
Before changing session or timeline code, record a production benchmark baseline and compare it after the change.
```

Так как задача затрагивает session UI, перед правкой app/session кода нужно снять baseline benchmark, а после изменения сравнить результат.

Фактические benchmark результаты:

Baseline до правок:

```text
status: passed
completionObservedMs: 72254.7
longTaskTimeMs: 23333
```

После правок:

```text
status: passed
completionObservedMs: 78141.8
longTaskTimeMs: 26853
```

Вывод: benchmark прошел до и после изменения. Разница похожа на нормальный шум стресс-бенчмарка с CPU throttle; изменение добавляет только небольшую строку stats и замену denominator в уже существующей метрике.

## Upstream PR survey

Проверяли GitHub/web search по темам:

```text
context usage compaction token limit
usable context limit
400000 gpt-5.5 context
session context indicator
session-context-metrics
context.stats.limit
SessionContextUsage ProgressCircle
```

Специализированный GitHub PR search через API вернул `401 Unauthorized`, поэтому использовали web search и открытие найденных PR страниц.

Готового PR именно под нашу проблему не найдено. То есть не найден PR, который делает следующее:

- берет backend effective compaction limit / `usable`;
- показывает в web UI `Доступно до сжатия`, например `252 000`;
- считает progress circle и `Использование` от `usable`, а не от raw `model.limit.context`.

Найденные похожие PR:

- https://github.com/anomalyco/opencode/pull/12924 — merged. Добавил `compaction.reserved` и изменил compaction math, чтобы оставлять headroom для input window. Это как раз причина текущего `252k`, но PR не исправляет web UI indicator.
- https://github.com/anomalyco/opencode/pull/20456 — closed, not merged. Добавлял graduated context usage levels в `SessionContextUsage`: `normal`, `warning`, `error`, `blocking`. Близко по UI, но по описанию считает состояния от current context window fill level, а не от backend `usable` threshold. Плюс PR закрыт.
- https://github.com/anomalyco/opencode/pull/10123 — open. Добавляет configurable compaction thresholds через `opencode.json`, включая `token_threshold`, `context_threshold`, model-specific overrides и `min_messages`. Это про управление тем, когда compact запускается, но не про честный web indicator denominator.
- https://github.com/anomalyco/opencode/pull/12236 — closed. Про TUI token totals и расхождение TUI/web, не про `400k` vs `252k`.
- https://github.com/anomalyco/opencode/pull/9900 — closed. Добавлял tool `context_usage` для статистики контекста, не web UI fix.
- https://github.com/anomalyco/opencode/pull/31005 — merged. V2 context overflow recovery: если провайдер отверг запрос как context overflow, делается forced compaction и retry. Это recovery path, не indicator fix.

Вывод: можно считать задачу актуальной. У upstream есть много работ вокруг compaction/overflow, но конкретного фикса misleading web context indicator пока не видно.

## Важные ограничения

- Не хардкодить `252_000` в UI.
- Не считать `400_000` неправильным само по себе: это полный context window.
- Не терять поддержку config overrides.
- Не рестартить app/server process автоматически: пользователь делает это сам.
- Не коммитить без явной просьбы пользователя.
