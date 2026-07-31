# План исправления multi-window SSE

## Причинная Цепочка

```text
второе окно открывает /global/event
        ↓
HTTP response уже создается, но GlobalBus listener еще не зарегистрирован
        ↓
основная сессия публикует message.part.updated
        ↓
первое окно получает событие, второе теряет его в startup gap
        ↓
listener второго окна начинает работать
        ↓
последующие message.part.delta приходят во второе окно
        ↓
client не находит part и отбрасывает delta
        ↓
timeline обновляется только в первом окне
```

## Изменение Server Flow

Файл:

```text
packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts
```

До исправления:

```text
создать response
→ отправить server.connected
→ лениво запустить Stream.callback
→ зарегистрировать GlobalBus listener
```

После исправления:

```text
создать per-connection Queue
→ зарегистрировать GlobalBus listener
→ создать Stream.fromQueue
→ вернуть response
→ отправить server.connected
→ читать уже накопленные live events
```

Listener регистрируется через scoped `Effect.acquireRelease`. При закрытии request/response scope удаляется именно listener этого соединения.

## Почему Broadcast Сохраняется

У каждого HTTP-соединения собственные:

```text
Queue
handler
stream
finalizer
```

`GlobalBus.emit("event", event)` вызывает handlers всех активных соединений. Каждый handler кладет событие в свою очередь, поэтому один subscriber не может забрать событие у другого.

## Regression Tests

Файл:

```text
packages/opencode/test/server/httpapi-global.test.ts
```

Добавлены сценарии:

1. Два одновременных `/global/event` subscribers получают `server.connected`, затем оба получают одно опубликованное событие.
2. Listener уже зарегистрирован после создания HTTP response: событие публикуется до запуска consumer response body и затем читается после `server.connected`.

## Проверки

Выполнены последовательно из `packages/opencode`, без параллельных тяжелых jobs:

```bash
bun test test/server/httpapi-global.test.ts --max-concurrency=4
bun typecheck
```

Результат focused tests:

```text
4 pass
0 fail
```

Package-local typecheck завершен успешно.

## Остаточные Ограничения

SSE endpoint по-прежнему не выполняет точный replay пропущенных событий после полноценного disconnect. Web app восстанавливает durable state через refetch/sync при `server.connected`. Добавление SSE event IDs и replay является отдельной задачей.
