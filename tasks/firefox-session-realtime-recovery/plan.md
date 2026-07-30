# Plan

## Диагностика

1. Проверить, существует ли session `start_task 9822 in close-service branch` в dev-базе.
2. Сравнить таблицы `message`/`part` и legacy/projected `session_message`.
3. Проверить живой endpoint `GET /session/:sessionID/message`.
4. Проверить legacy endpoint `GET /api/session/:sessionID/message`.
5. Проверить journal `opencode-web.service` на SSE/listener warnings.
6. Изучить frontend flow: session fetch, SSE subscription, event reducers, reconnect handling.

## Найденные факты

Session найдена:

```text
id: ses_0c9e04827ffee0W0ndfVLLEnET
title: start_task 9822 in close-service branch
time_created: 2026-07-06T06:31:16.184Z
time_updated: 2026-07-30T07:36:53.497Z
```

Содержимое таблиц:

```text
session_message: 4 rows
message: 4149 rows
part: 22561 rows
```

Правильный endpoint:

```text
GET /session/ses_0c9e04827ffee0W0ndfVLLEnET/message
```

вернул `4149` сообщений. Последнее сообщение:

```text
assistant msg_fb1f4228d001AKEhx0or4PdxlT
created: 2026-07-30T07:36:34.701Z
preview: Какой тест нужно запустить или проверить?
```

Legacy endpoint:

```text
GET /api/session/ses_0c9e04827ffee0W0ndfVLLEnET/message?limit=20
```

вернул объект с `data` из 4 projected records: `agent-switched` и `model-switched`.

Последние durable messages после `2026-07-29T11:50Z`:

```text
2026-07-29T11:50:05Z user
2026-07-29T11:50:06Z assistant finish=tool-calls
2026-07-29T11:54:09Z assistant finish=tool-calls
2026-07-29T11:54:48Z assistant finish=tool-calls
2026-07-29T11:55:49Z assistant finish=tool-calls
2026-07-29T11:56:22Z assistant finish=tool-calls
2026-07-29T11:56:41Z assistant finish=stop
2026-07-30T07:36:31Z user text="тест"
2026-07-30T07:36:34Z assistant finish=stop
```

В последних 100 messages найдена одна сохраненная ошибка, но она раньше этого участка:

```text
2026-07-29T11:10:12Z assistant error=MessageAbortedError
```

Это значит: история, которая была durable-saved, на месте. Если после `2026-07-29T11:56Z` были ответы, которые пользователь видел только в браузере, но они не попали в таблицы `message`/`part`, восстановить их из SQLite уже нельзя.

## Техническая гипотеза

Есть две независимые проблемы, которые могут давать похожий симптом:

1. Firefox держит stale frontend/cache и использует не тот API path для timeline.
2. SSE stream теряет events или reconnect происходит без refresh активной session timeline.

Вторая проблема подтверждается архитектурно: клиент получает `server.connected`, но не делает forced session message sync. Если во время разрыва SSE были записаны новые parts, browser state остается старым до reload.

## Предпочтительный fix

Минимально изменить frontend sync layer:

- при global `server.connected` или `global.disposed` пройти по уже загруженным session ids;
- вызвать forced session sync для них с сохранением текущего retained message limit;
- не сбрасывать полностью store и не менять projection logic;
- оставить обычный event reducer как быстрый путь для live updates.

Такой fix делает reconnect идемпотентным: если events не терялись, forced fetch просто подтвердит текущее состояние; если events потерялись, fetch догонит durable SQLite state.

## Измененные файлы

```text
packages/app/src/context/server-sync.tsx
packages/opencode/src/server/shared/ui.ts
```

При `server.connected` / `global.disposed`, если это не самый первый boot, клиент теперь делает forced sync для уже загруженных session timelines через `session.sync(sessionID, { force: true })`.

Важно: это не пытается восстановить state из SSE. Мы просто заново читаем durable state через правильный endpoint `GET /session/:sessionID/message`, который уже подтвердил наличие всех `4149` сообщений session `9822`.

Embedded UI response теперь выставляет cache headers:

```text
HTML: no-store
/assets/*: public, max-age=31536000, immutable
other embedded files: no-cache
```

Это нужно, чтобы после обновления бинаря Firefox не продолжал использовать stale `index.html` со старым JS bundle/API-client.

## Проверки

Перед изменением session/timeline кода нужно снять production benchmark baseline из `packages/app`.

Планируемые проверки:

```bash
cd packages/app
bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts
bun typecheck
```

Если добавим unit test для sync behavior, запустить точечный `bun test` из `packages/app`, не из repo root.

## Baseline benchmark до правок

Command:

```bash
cd packages/app
bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts
```

Status: passed.

Ключевые метрики:

```text
completionObservedMs=76738.1
longTaskTimeMs=28658
rowReplaced=false
markdownReplaced=false
bottomDriftTransitions=0
blankSamples=0
```

## Проверки после правок

Commands:

```bash
cd packages/app
bun typecheck
bun test --preload ./happydom.ts ./src/context/server-sync.test.ts ./src/context/server-session.test.ts ./src/context/server-sdk.test.ts
bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts
```

Results:

```text
bun typecheck: passed
unit tests: 16 pass, 0 fail
benchmark: passed
```

Post-change benchmark metrics:

```text
completionObservedMs=80995.3
longTaskTimeMs=31673
rowReplaced=false
markdownReplaced=false
bottomDriftTransitions=0
blankSamples=0
```

Сравнение с baseline:

```text
completionObservedMs: 76738.1 -> 80995.3
longTaskTimeMs: 28658 -> 31673
```

Одного прогона недостаточно, чтобы делать строгий вывод о скорости: benchmark шумный, а reconnect branch в обычном streaming сценарии почти не должен выполняться. Важнее, что post-change benchmark не показал remount, scroll drift или blank timeline regression.
