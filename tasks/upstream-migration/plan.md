# План перехода на актуальный upstream OpenCode

## Краткое решение

Не вливать 935 upstream commits в текущую локальную ветку. Вместо этого:

1. Сохранить текущую `dev` как неизменяемую rollback-ветку.
2. Создать новую ветку `upstream-migration` непосредственно от `anomalyco/opencode:dev`.
3. Проверить чистый upstream с копией конфигурации и копией базы данных.
4. Перенести только нужные локальные функции, адаптируя их под текущую архитектуру.
5. Переключить production service только после полного smoke-теста.

Такой подход уменьшает число конфликтов и позволяет проверять каждую локальную функцию отдельно.

## Исходное состояние

Состояние зафиксировано 11 августа 2026 года:

| Параметр | Значение |
|---|---|
| Локальная ветка | `dev` |
| Локальный HEAD | `a637f7d3d6c3f09afc51c851414c7e824df4b632` |
| Проверенный upstream HEAD | `941e71dbbb94ea5b32226c2845585992dadb361f` |
| Общий merge-base | `9ad70679716dac2f76d78bbc754b0635357f3a6c` |
| Только в локальной ветке | 16 commits |
| Только в upstream | 935 commits |
| Предсказанные merge conflicts | 14 файлов |

Upstream commit является снимком на момент составления плана. Перед фактической миграцией нужно заново выполнить `git fetch upstream dev` и зафиксировать новый commit hash в результатах задачи.

## Инвентаризация локальных commits

Обозначения в таблице:

- **Да**: функцию сохраняем, но переносим отдельным адаптированным commit.
- **Условно**: сначала проверяем чистый upstream; переносим только отсутствующую часть.
- **Нет**: upstream уже решает проблему или commit не несет самостоятельной функциональности.
- **Локально**: сохраняем в личном fork, но не предлагаем upstream как универсальное изменение.

| Commit | Что делает | Состояние в upstream | Переносим? | Как поступаем |
|---|---|---|---|---|
| `a637f7d3d` `feat(tool): add historical bash output retrieval` | Сохраняет полный вывод tools и дает модели `tool_output`, чтобы получить старый результат по `callID` после обрезки контекста | Частично реализовано иначе в V2 через `ToolOutputStore`: большой output сохраняется в managed file и публикуется через `outputPaths`. Отдельного `tool_output(callID)` для legacy/pruned history нет | **Условно** | Сначала проверить V2 на сценариях large output и compaction. Если managed path остается доступен модели, старый commit не переносить. Если после pruning путь теряется, добавить минимальный retrieval-механизм в V2, а не cherry-pick старой V1-реализации |
| `df139524e` `docs(app): record multi-window SSE verification` | Добавляет результат ручной проверки двух вкладок после SSE fix | Это исторический отчет старой реализации | **Нет** | Не переносить commit. Результат новой multi-window проверки записать в этот migration plan или новую актуальную задачу |
| `c14519776` `fix(app): keep background SSE streams responsive` | Заменяет throttled timer/yield на `MessageChannel` для обработки events в background tab | Точного эквивалента нет. Актуальный upstream по-прежнему использует `setTimeout` для flush и `wait(0)` для yield | **Условно** | На чистом upstream воспроизвести длительный background-tab streaming. Если events снова задерживаются, адаптировать `MessageChannel` к текущему `server-sdk.tsx` и добавить focused tests |
| `977370033` `fix(opencode): prevent global SSE event loss` | Регистрирует subscriber до запуска HTTP response body, чтобы не терять events между подключением и `server.connected` | В новом V2 `/event` используется eager queue и проблема исправлена. Legacy `/global/event` все еще использует lazy `Stream.callback` | **Условно** | Для основного V2 transport не переносить. Legacy handler менять только если актуальная конфигурация реально использует V1 `/global/event` и focused test воспроизводит потерю |
| `41b61c552` `fix: limit verification concurrency` | Ограничивает Turbo, Bun test и Playwright concurrency, чтобы VM не уходила в OOM | Отсутствует; это локальное ограничение конкретной VM | **Да, локально** | Перенести правила в новый `AGENTS.md`. Сохранить `--concurrency=2`, `--max-concurrency=4`, `PLAYWRIGHT_WORKERS=1`. Изменение root `package.json` делать отдельным локальным commit после проверки новых scripts |
| `f28faa14e` `docs: document tool result context strategy` | Документирует стратегию сохранения, pruning и повторного получения tool results | Старый документ отсутствует, но upstream V2 имеет новую модель `ToolOutputStore` и собственный `CONTEXT.md` | **Да, документацию** | Не cherry-pick старый документ вслепую. Сравнить его решения с upstream `CONTEXT.md`, перенести только актуальные gaps и сохранить итог исследования в `tasks/` |
| `bc8715257` `fix(app): refresh sessions after reconnect` | После reconnect принудительно синхронизирует загруженные timelines; задает безопасные cache headers для embedded UI | Upstream обновляет bootstrap/активные directories при `server.connected`, но не выполняет эквивалентный forced sync всех загруженных timelines. Cache headers также отсутствуют | **Условно** | Воспроизвести disconnect во время streaming и возврат из background. Если timeline остается stale, реализовать targeted sync в новой `server-session`/`directory-sync` архитектуре. Cache headers проверить отдельно через HTTP response tests |
| `179845cc5` `fix(opencode): cap openai gpt-5.6 usable context` | Ограничивает usable context GPT-5.6, чтобы compaction происходил до фактического provider limit | Upstream задает для OpenAI OAuth/Codex GPT-5.6 `input=372000`, `output=128000`; итоговый pre-compaction threshold близок к локальному | **Нет** | Использовать upstream limits. Добавить smoke-test для используемой модели `gpt-5.6-sol-fast`; отдельный patch нужен только если direct API-key provider снова получает неверный limit |
| `1c92646ee` `feat(session-ui): render mermaid markdown blocks` | Рендерит `mermaid`, `mmd` и `graphmermaid` code fences как SVG diagrams с fallback на code block | В upstream отсутствует. Похожие PR, включая `#21497`, не смержены. Markdown parsing теперь перенесен в worker | **Да** | Реализовать заново поверх текущего markdown worker pipeline. Сохранить lazy import, sanitization, streaming fallback, последовательный render и cleanup. Добавить тесты для Mermaid 9.2.2-compatible syntax и обычных code blocks |
| `2d100813f` `fix(app): use effective context limit` | Показывает процент context относительно usable limit до compaction, а не полного provider context | Core upstream вычисляет usable threshold, но UI/API продолжает показывать полный context limit | **Да** | Добавить current-schema поле для effective/usable limit, обновить generated client и новый context UI. Не переносить старые файлы напрямую из-за переработанной архитектуры app |
| `580a2aa4f` merge commit | Объединяет две локальные линии истории | Самостоятельной функциональности нет | **Нет** | Merge commit не переносить |
| `ee1383446` `feat(app): add configurable session width` | Добавляет настройку ширины session content в app и TUI | Upstream имеет новую resize/layout систему, но точной настройки максимальной ширины нет | **Нет на первом этапе** | Сначала оценить upstream resize UX. Если его достаточно, commit не нужен. Если ширины не хватает, создать отдельную задачу и интегрировать настройку в новую `layout.session.width`, не возвращая старую реализацию |
| `5cbbcef7f` `readme` | Добавляет в README строку о личном fork | В upstream, естественно, отсутствует; runtime не затрагивает | **Нет** | Не создавать конфликт с upstream README. Локальный характер fork описать в migration task или GitHub repository description |
| `8c270f784` merge commit | Merge PR с исправлением loop-exit | Самостоятельной функциональности нет | **Нет** | Merge commit не переносить |
| `d1f5eabdf` merge commit | Синхронизирует branch исправления loop-exit | Самостоятельной функциональности нет | **Нет** | Merge commit не переносить |
| `225fb1cf1` `fix(session): use parent relationship instead of ID ordering for loop exit condition` | Не допускает duplicate loop, когда client-generated message ID сортируется после assistant ID | Основной баг исправлен upstream: loop использует `parentID`, а latest message выбирается по `time.created` | **Нет** | Использовать upstream implementation и его regression tests. Отдельно проверить открытие очень старых sessions без корректного `parentID` |

## Итоговый набор переносимых возможностей

### Переносим обязательно

1. Ограничения verification concurrency для слабой VM.
2. Mermaid rendering в session Markdown, адаптированный к worker pipeline.
3. Effective context indicator до compaction.
4. Актуализированную документацию про tool output и pruning.

### Переносим только после воспроизведения на чистом upstream

1. Background-tab `MessageChannel` scheduling.
2. Forced session timeline sync после reconnect.
3. Legacy `/global/event` eager subscription.
4. Retrieval старых tool outputs поверх V2 `ToolOutputStore`.

### Не переносим

1. GPT-5.6 context cap в старом виде.
2. Loop-exit fix.
3. Merge commits.
4. Строку в upstream README.
5. Старую реализацию session width на первом этапе.
6. Старые verification-only документы без актуализации.

## Этап 1. Подготовить безопасную Git-структуру

Этот этап не должен менять текущую рабочую ветку.

1. Убедиться, что все нужные текущие изменения либо committed, либо отдельно сохранены. Сейчас `tasks/openai-aborted/` не отслеживается Git и должен быть сохранен до переключения веток.
2. Добавить remote `upstream`, указывающий на `https://github.com/anomalyco/opencode.git`.
3. Получить актуальную ветку `upstream/dev`.
4. Создать rollback-ветку от текущего HEAD, например `legacy-local`.
5. Создать новую ветку `upstream-migration` от точного `upstream/dev`.
6. Не перемещать `dev` до завершения проверки migration branch.

Почему нужна отдельная rollback-ветка: после перехода база или конфигурация могут быть автоматически мигрированы. Возможность вернуть старый исходный код должна сохраняться независимо от состояния новой ветки.

## Этап 2. Зафиксировать baseline текущей сборки

До перехода нужно записать поведение, которое нельзя потерять:

| Сценарий | Что фиксируем |
|---|---|
| Открытие существующей session | Session list, messages, tool parts, permissions, todos |
| OpenAI prompt | Provider/model, OAuth flow, первый token, tool call, continuation |
| Context indicator | Текущие token count, effective limit, момент compaction |
| Mermaid | Flowchart, sequence diagram, invalid diagram fallback |
| Большой bash output | Preview, место хранения полного output, повторное чтение |
| Tool result после compaction | Может ли модель получить старый результат без повторного запуска команды |
| Две вкладки | Обе вкладки получают streaming updates |
| Background tab | После возврата виден полный ответ без reload |
| SSE reconnect | После разрыва timeline догоняет durable state |
| Session width | Текущая настройка и фактическая ширина на desktop/mobile |

Baseline должен включать версии бинаря, commit hash, используемую конфигурацию и относящиеся к проверке строки лога. Секреты в публикуемые документы не копировать.

## Этап 3. Подготовить копии данных и конфигурации

Перед первым запуском upstream build:

1. Остановить только тестовый экземпляр OpenCode, если он пишет в копируемую базу.
2. Скопировать `opencode-dev.db`, `opencode-dev.db-wal` и `opencode-dev.db-shm` как согласованный набор либо использовать SQLite backup API.
3. Сохранить копии `auth.json`, `account.json` и глобального `opencode.jsonc`.
4. Сохранить service unit, environment-файлы и точный путь запускаемого бинаря.
5. Первый запуск upstream выполнять на копии data directory, а не на единственном production data directory.

Важно: SQLite WAL содержит еще не checkpointed изменения. Нельзя копировать только основной `.db`, пока процесс продолжает запись.

## Этап 4. Проверить чистый upstream без локальных patches

Сначала нужно понять, что уже работает без наших изменений.

1. Установить зависимости и собрать upstream с ограниченной concurrency.
2. Выполнить package-local typecheck и focused tests последовательно, не параллельно.
3. Запустить отдельный upstream instance на другом HTTP port и с отдельным data directory.
4. Проверить загрузку глобальной конфигурации.
5. Проверить, как V1 config с `provider`, `agent` и `permission` мигрируется в актуальную конфигурационную модель.
6. Не смешивать V1 и V2 поля в одном config document: upstream может классифицировать документ как V1 и проигнорировать V2-only поля.
7. Проверить OAuth OpenAI и фактические provider options через debug config/API.
8. Выполнить все baseline-сценарии и заполнить decision gates для условных commits.

## Этап 5. Перенести локальные изменения отдельными commits

Рекомендуемый порядок уменьшает вероятность смешать независимые проблемы:

1. `chore: limit verification concurrency` — только локальная build safety.
2. `fix(app): show effective context limit` — schema/API/client/UI одним завершенным изменением.
3. `feat(session-ui): render mermaid diagrams` — новая реализация для worker pipeline.
4. `fix(app): recover session state after reconnect` — только если upstream test воспроизводит stale timeline.
5. `fix(app): keep background events responsive` — только если background test воспроизводит throttling.
6. `feat(tool): retrieve retained tool output` — только если V2 `ToolOutputStore` не закрывает acceptance criteria.

Каждый commit должен иметь собственные focused tests. Нельзя объединять Mermaid, SSE, context и tool output в один большой commit: это усложнит последующие rebase на upstream.

## Этап 6. Проверки

### Статические проверки

1. `git diff --check`.
2. Package-local `bun typecheck` только для измененных packages.
3. При необходимости полный `bun turbo typecheck --concurrency=2`.

### Focused tests

| Область | Обязательная проверка |
|---|---|
| Config/data migration | Открытие копии текущей DB и чтение старых sessions |
| OpenAI | Prompt, tool call, continuation, header timeout больше 10 секунд |
| Context | Расчет usable limit и UI percentage |
| Mermaid | Valid, invalid, streaming, repeated diagrams, theme change, sanitization |
| Tool output | Большой output, managed path, retention, compaction, retrieval без rerun |
| SSE server | Одновременные subscribers и event сразу после подключения |
| SSE client | Reconnect, background tab, page restore, missed durable updates |
| Multi-window | Две вкладки видят один streaming timeline |
| Mobile | Layout и восстановление после background/resume |

### Ограничения ресурсов

- Не запускать build, typecheck и test одновременно.
- Turbo запускать с `--concurrency=2`.
- Package-wide Bun tests ограничивать `--max-concurrency=4`.
- Playwright запускать с `PLAYWRIGHT_WORKERS=1`.
- Сначала использовать focused tests; полный repository build запускать только перед cutover.

## Этап 7. Production cutover

1. Остановить production service.
2. Сделать финальную согласованную копию SQLite и конфигурации.
3. Зафиксировать старый binary path и commit hash.
4. Установить проверенную upstream-based сборку под новым versioned path.
5. Обновить service command только на новый versioned path.
6. Запустить service и проверить health endpoint.
7. Проверить логи startup/config/database migration.
8. Открыть старую session, выполнить OpenAI prompt и tool call.
9. Выполнить multi-window и reconnect smoke-test.
10. Не удалять старый binary и backup данных до нескольких дней стабильной работы.

## Rollback

Rollback считается готовым только при наличии старого кода, старого бинаря и совместимой копии данных.

1. Остановить новую сборку.
2. Сохранить ее логи и текущую новую DB для диагностики.
3. Вернуть service command на старый versioned binary.
4. Если новая версия меняла schema/data, восстановить старый согласованный SQLite backup.
5. Запустить старую сборку и проверить health/session list.

Нельзя просто запустить старый binary поверх уже мигрированной новой DB: downgrade schema может не поддерживаться.

## Дальнейшее сопровождение fork

После миграции рекомендуется следующая модель:

1. `upstream` всегда указывает на `anomalyco/opencode`.
2. `origin` остается личным fork `arbocdi/opencode`.
3. Локальная рабочая ветка содержит только небольшой линейный набор локальных commits поверх upstream.
4. Обновление выполняется частым rebase/переносом небольшого набора commits, а не редкими слияниями сотен upstream commits.
5. Универсальные изменения, например Mermaid или SSE regression tests, по возможности оформляются отдельными upstream PR.
6. VM-specific concurrency остается локальным commit и не смешивается с runtime changes.

## Критерии завершения

Миграция завершена, если одновременно выполняются условия:

1. Новая сборка основана на актуальном upstream `dev`.
2. Существующие sessions открываются без потери сообщений и tool state.
3. OpenAI OAuth и используемые модели работают.
4. Нет 10-секундного default OpenAI header timeout.
5. Context UI показывает согласованное с compaction значение.
6. Mermaid diagrams отображаются либо явно принято решение временно оставить code blocks.
7. Background/reconnect/multi-window тесты проходят.
8. Большой tool output не заставляет модель повторно запускать потенциально неидемпотентную команду.
9. Build и проверки не вызывают OOM на VM.
10. Rollback проверен и документирован.

## Оценка сложности

| Часть | Оценка |
|---|---|
| Создать безопасную upstream branch и тестовый instance | Низкая |
| Проверить config и копию DB | Средняя |
| Перенести effective context UI | Средняя |
| Адаптировать Mermaid к worker pipeline | Средняя/высокая |
| Проверить и при необходимости перенести SSE fixes | Средняя/высокая |
| Проверить V2 ToolOutputStore и закрыть retrieval gap | Средняя/высокая |
| Production cutover и rollback | Средняя |

Главный риск находится не в Git-командах, а в переносе пользовательских функций на изменившуюся V2-архитектуру и в безопасной миграции существующих данных.
