# План исправления multi-window SSE

## Уточнение После Проверки

Первый server-side фикс устранил startup gap и подтвержден отдельными тестами, но пользовательский симптом сохранился после сборки и рестарта. После рестарта сервер видел несколько живых `/global/event` подключений без disconnect-loop. Поэтому фактическая устойчивая проблема находилась дальше по flow, в обработке stream фоновым browser window.

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

Дополнительная причинная цепочка для уже подключенного фонового окна:

```text
окно становится hidden/background
        ↓
SSE reader доходит до await setTimeout(0)
        ↓
browser throttling задерживает timer
        ↓
JS перестает вызывать reader.read(), хотя TCP остается established
        ↓
либо события уже прочитаны, но setTimeout(flush) не запускается вовремя
        ↓
Solid state и timeline фонового окна не обновляются
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

## Изменение Web Client Flow

Файл:

```text
packages/app/src/context/server-sdk.tsx
```

Для видимого документа сохраняется 16-ms timer batching перед применением событий. Cooperative stream yield выполняется через `MessageChannel`, чтобы один большой buffered burst не занял event loop целиком:

```text
события batch-ятся примерно на 16 ms
stream loop периодически делает cooperative MessageChannel yield
```

Для hidden/background документа timer больше не используется ни для cooperative yield внутри SSE reader, ни для запуска coalesced flush:

```text
получить событие
→ добавить событие в существующую coalescing queue
→ запланировать один flush через MessageChannel task queue
→ периодически отдать управление event loop через ту же task queue
```

`MessageChannel` создает обычные event-loop tasks без timer delay. Это сохраняет cooperative backpressure и batching, но не зависит от browser throttling для `setTimeout` в background window. При возвращении документа в `visible` накопленная очередь дополнительно принудительно flush-ится до проверки heartbeat/reconnect.

Если окно переходит в `hidden`, когда foreground flush timer уже ожидает выполнения, timer отменяется, а накопленная очередь перепланируется через `MessageChannel`. Иначе старый throttled timer продолжал бы блокировать background scheduling.

## Regression Tests

Файл:

```text
packages/opencode/test/server/httpapi-global.test.ts
```

Добавлены сценарии:

1. Два одновременных `/global/event` subscribers получают `server.connected`, затем оба получают одно опубликованное событие.
2. Listener уже зарегистрирован после создания HTTP response: событие публикуется до запуска consumer response body и затем читается после `server.connected`.
Тесты web client находятся в:

```text
packages/app/src/context/server-sdk.test.ts
```

Они проверяют выбор timer policy по visibility и асинхронное выполнение background stream work через task queue.

## Проверки

Server-проверки выполнены последовательно из `packages/opencode`, без параллельных тяжелых jobs:

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

Web client проверки выполнены последовательно из `packages/app`:

```bash
bun test src/context/server-sdk.test.ts --only-failures --max-concurrency=4
bun typecheck
```

Результат focused app tests:

```text
6 pass
0 fail
```

App package-local typecheck завершен успешно.

После повторной сборки и рестарта сервиса исправление проверено в реальном web-интерфейсе: две одновременно открытые вкладки получили обновления streaming timeline. Устойчивый пользовательский симптом больше не воспроизводится.

## Остаточные Ограничения

SSE endpoint по-прежнему не выполняет точный replay пропущенных событий после полноценного disconnect. Web app восстанавливает durable state через refetch/sync при `server.connected`. Добавление SSE event IDs и replay является отдельной задачей.
