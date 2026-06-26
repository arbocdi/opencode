# Исправление индикатора заполнения контекста

## Контекст

В web UI opencode есть вкладка `Контекст`. На скриншоте для сессии с OpenAI GPT-5.5 она показывает:

```text
Лимит контекста: 400 000
Всего токенов:   97 424
Использование:   24%
```

Проблема: этот индикатор выглядит так, будто до заполнения контекста еще далеко. Но фактически auto-compaction для такой модели должен сработать примерно на `252 000` токенов, а не на `400 000`.

Из-за этого пользователь видит примерно половину индикатора, хотя usable context до сжатия уже почти закончился. Это опасно для длинных рабочих сессий: UI дает ложное ощущение запаса.

## Что нужно исправить

Нужно, чтобы индикатор использования контекста считал процент не от полного theoretical context window модели, а от effective budget, при котором opencode реально считает сессию переполненной и запускает сжатие.

Для GPT-5.5 сейчас это примерно:

```text
input limit:          272 000
compaction reserved:   20 000
effective limit:      252 000
```

То есть при `97 424` токенах индикатор должен показывать примерно:

```text
97 424 / 252 000 = 39%
```

А не:

```text
97 424 / 400 000 = 24%
```

## Важное различие терминов

У модели есть несколько разных лимитов, и для UI они означают разные вещи:

- `context` — полный context window модели, например `400 000`.
- `input` — сколько input tokens модель принимает в запросе, например `272 000`.
- `output` — сколько output tokens модель может сгенерировать, например `128 000`.
- `reserved` — буфер, который opencode оставляет перед сжатием, по умолчанию до `20 000`.
- `usable` или `effective limit` — реальный порог, с которым сравнивается размер сессии перед auto-compaction.

Вкладка `Контекст` сейчас использует `context`, но для индикатора заполнения сессии пользователю нужен `usable`.

## Исследованный root cause

Для OpenAI OAuth plugin GPT-5.5 задается так:

```ts
limit: {
  context: 400_000,
  input: 272_000,
  output: 128_000,
}
```

Это находится в:

```text
packages/opencode/src/plugin/openai/codex.ts
```

UI берет именно `model.limit.context` и считает percentage так:

```text
usage = totalTokens / contextLimit
```

Это находится в:

```text
packages/app/src/components/session/session-context-metrics.ts
```

Но backend compaction logic использует другую формулу:

```text
usable = model.limit.input - reserved
```

Если `model.limit.input` отсутствует, используется fallback:

```text
usable = model.limit.context - maxOutputTokens
```

Это находится в:

```text
packages/opencode/src/session/overflow.ts
```

Для GPT-5.5 получается:

```text
reserved = min(20 000, maxOutputTokens)
usable   = 272 000 - 20 000
usable   = 252 000
```

## Почему это не просто ошибка `400 000`

`400 000` само по себе может быть корректным полным окном модели. Но для UX вкладки `Контекст` важен не полный theoretical context window, а реальный лимит, после которого opencode начнет compact/summarize session.

Поэтому хороший UI может показывать обе величины:

- полный лимит модели: `400 000`;
- доступно до сжатия: `252 000`;
- индикатор/progress: считать от `252 000`.

## Возможные переопределения

Лимиты модели могут переопределяться через provider config:

```jsonc
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5": {
          "limit": {
            "context": 400000,
            "input": 272000,
            "output": 128000
          }
        }
      }
    }
  }
}
```

Порог reserved для compaction тоже может переопределяться:

```jsonc
{
  "compaction": {
    "reserved": 20000
  }
}
```

Значит фикс должен учитывать runtime config, а не хардкодить `252000` только для GPT-5.5.

## Ожидаемый результат

После исправления web UI должен показывать пользователю честную картину:

- progress circle не должен считать процент от `400 000`, если auto-compaction сработает на `252 000`;
- вкладка `Контекст` должна явно различать полный лимит модели и effective limit до сжатия;
- если пользователь переопределил `provider.*.models.*.limit` или `compaction.reserved`, UI должен соответствовать реальной backend-логике.

## Что сделали в реализации

Реализован вариант `backend отдает computed effective limit`.

Backend теперь добавляет в provider/model response поле:

```ts
limit.usable
```

Это поле означает effective usable budget, то есть реальный лимит, с которым opencode сравнивает размер сессии перед auto-compaction.

Для GPT-5.5 при default config это будет примерно:

```text
context: 400 000
input:   272 000
output:  128 000
usable:  252 000
```

Web UI теперь делает так:

- поле `Лимит контекста` продолжает показывать полный raw context window модели;
- добавлено поле `Доступно до сжатия`;
- `Использование` считается от `limit.usable`, если backend его отдал;
- маленький круглый context indicator тоже использует тот же corrected usage percentage;
- если `limit.usable` по какой-то причине отсутствует, UI fallback-ится на старое поведение и считает от `limit.context`.

## Измененные основные файлы

```text
packages/opencode/src/provider/context-limit.ts
packages/opencode/src/provider/provider.ts
packages/opencode/src/session/overflow.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts
packages/app/src/components/session/session-context-metrics.ts
packages/app/src/components/session/session-context-tab.tsx
packages/app/src/components/session/session-context-metrics.test.ts
packages/app/src/i18n/en.ts
packages/app/src/i18n/ru.ts
packages/opencode/test/server/httpapi-provider.test.ts
packages/sdk/js/src/v2/gen/types.gen.ts
```

## Проверки после реализации

Прошли:

```bash
cd packages/app
/home/arbocdi/.bun/bin/bun test src/components/session/session-context-metrics.test.ts
/home/arbocdi/.bun/bin/bun typecheck
```

```bash
cd packages/opencode
/home/arbocdi/.bun/bin/bun test test/server/httpapi-provider.test.ts
/home/arbocdi/.bun/bin/bun typecheck
```

```bash
cd packages/sdk/js
/home/arbocdi/.bun/bin/bun typecheck
```

Также был повторно прогнан production benchmark session timeline. Он прошел до и после изменения.
