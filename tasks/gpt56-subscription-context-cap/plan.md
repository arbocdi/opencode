# План реализации GPT-5.6 context cap

## Точка изменения

Общая точка для UI и auto-compaction уже существует:

```text
packages/opencode/src/provider/context-limit.ts
```

Функция `ProviderContextLimit.usable(...)` используется:

- в HTTP provider endpoints, чтобы UI получил `model.limit.usable`;
- в `packages/opencode/src/session/overflow.ts`, чтобы auto-compaction решил, пора ли сжимать.

Поэтому cap нужно поставить именно там. Так мы избежим ситуации, когда UI показывает один предел, а сервер сжимает по другому.

## Техническое решение

1. Добавить helper, который распознает прямые OpenAI GPT-5.6 модели:

```text
providerID === "openai"
api.id starts with "gpt-5.6"
```

2. Для таких моделей возвращать:

```text
Math.min(calculatedUsable, 350_000)
```

3. Оставить остальные модели без изменений.

## Проверки

Нужны focused tests:

- direct OpenAI GPT-5.6 получает `usable=350_000`;
- auto-compaction считает overflow при `350_000` токенов;
- custom/OpenAI-compatible provider с `gpt-5.6` не получает cap, чтобы не ломать Requesty/OpenRouter.

Команды проверки:

```bash
cd packages/opencode
bun test test/session/compaction.test.ts test/server/httpapi-provider.test.ts
bun typecheck
```

Если меняется только server/provider context calculation, app performance benchmark не нужен: session timeline rendering не меняется.

## Результат

Реализовано:

- `ProviderContextLimit.usable(...)` сначала считает обычный usable limit, как раньше;
- затем для direct OpenAI provider и `api.id` с префиксом `gpt-5.6` применяет cap `350_000`;
- custom/OpenAI-compatible providers не ограничиваются этим cap.

Проверки выполнены:

```bash
cd packages/opencode
bun test test/session/compaction.test.ts test/server/httpapi-provider.test.ts
bun typecheck
```

Результат:

```text
60 pass
2 skip
0 fail
```
