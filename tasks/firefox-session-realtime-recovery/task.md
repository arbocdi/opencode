# Firefox session realtime recovery

## Контекст

В Firefox web UI opencode начал плохо обновлять session timeline: ответы AI иногда не появляются live и становятся видны только после reload. Для session:

```text
ses_0c9e04827ffee0W0ndfVLLEnET
title: start_task 9822 in close-service branch
directory: /work/programming/saw
```

пользователь увидел только сообщения за прошлый день и подумал, что часть session потеряна.

## Что уже проверено

Данные в dev-базе физически не потеряны:

```text
/home/arbocdi/.local/share/opencode/opencode-dev.db
message rows: 4149
part rows: 22561
session_message rows: 4
```

Правильный endpoint текущего app UI:

```text
GET /session/:sessionID/message
```

Он отдает все `4149` сообщений, включая свежий тест от `2026-07-30T07:36Z`.

Legacy/V2 projected endpoint:

```text
GET /api/session/:sessionID/message
```

отдает только `4` записи из `session_message`, поэтому если старый frontend или неверный SDK path использует его для timeline, UI покажет неполную историю.

В journal сервиса найден симптом:

```text
MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 event listeners added
```

Это похоже на накопление SSE-подписок или неидеальное закрытие старых realtime streams. Даже если это не первопричина, текущий app не делает durable replay missed events после reconnect, поэтому пропущенные `message.part.delta` / `message.part.updated` могут оставить timeline stale до reload.

## Что делаем

Сначала делаем минимальный стабильный fix для восстановления UI после reconnect:

- при `server.connected` / reconnect не полагаться только на будущие realtime events;
- принудительно refresh активных/уже загруженных session messages, чтобы догнать события, которые Firefox мог пропустить;
- не давать Firefox держать stale embedded UI HTML после обновления бинаря;
- не менять формат хранения данных;
- не трогать реальные session rows;
- перезапуск сервиса делать только отдельным deployment step после commit/rebuild и по явной просьбе пользователя.

## Что не делаем

- Не чистим Firefox profile автоматически.
- Не удаляем и не переносим строки из SQLite.
- Не меняем `/api/session/:id/message`, потому что это отдельный projected-message API.
- Не оптимизируем всю большую session timeline в этой задаче, хотя session `9822` уже очень тяжелая: `22561` parts и база `1.8G`.
