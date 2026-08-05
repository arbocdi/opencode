# План аудита контекста сессии 9945

## Индекс пунктов проекции

Для быстрого переключения используй стабильный ID пункта, например: `переключись на PROJ-3` или `делай дальше PROJ-3`. ID не зависят от положения раздела в файле и не должны переименовываться при дополнении плана.

| ID | Инструмент или область | Что отдельно исследуем и реализуем | Статус |
|---|---|---|---|
| [`PROJ-1`](#proj-1) | `bash` | Проекция команд, успешных и ошибочных логов, восстановление полного output | Завершен |
| [`PROJ-2`](#proj-2) | `read` | Актуальное повторное чтение и доступ к историческому содержимому | Запланирован |
| [`PROJ-3`](#proj-3) | `grep` | Воспроизводимая проекция содержательного поиска и устаревание выдачи | Запланирован |
| [`PROJ-4`](#proj-4) | `glob` | Проекция поиска файлов и политика сохранения коротких списков | Запланирован |
| [`PROJ-5`](#proj-5) | `todowrite` | Защита последнего состояния и вытеснение устаревших snapshots | Запланирован |
| [`PROJ-6`](#proj-6) | `task` | Защита итоговых отчетов субагентов и обработка failed/interrupted results | Запланирован |
| [`PROJ-7`](#proj-7) | `skill` | Защита инструкций и возможная дедупликация повторных загрузок | Запланирован |
| [`PROJ-8`](#proj-8) | Неизвестный или plugin tool | Безопасная fallback-политика для неизвестных контрактов | Запланирован |
| [`PROJ-DOD`](#proj-dod) | Общие критерии | Durable result, безопасность `callID`, tests, token savings и prompt cache | Применяется к каждому пункту |

## 1. Получение структуры сессии

- Найти сессию по title и зафиксировать полный ID.
- Прочитать `message` и `part` из SQLite в read-only режиме.
- Определить количество user/assistant messages, provider turns, tool calls, compactions и дочерних subagent sessions.

## 2. Количественный анализ

Для каждого part посчитать:

- тип part;
- инструмент;
- размер input и output в символах и приближенных токенах;
- состояние pruning/compaction;
- положение в истории;
- число последующих provider turns, в которые результат мог повторно попасть.

Сгруппировать результаты по категориям:

- исследование кода: `read`, `glob`, `grep`, explore-задачи;
- выполнение команд: `bash`, тесты, сборка, Git;
- логи и большие диагностические выводы;
- веб-запросы и внешние API;
- результаты субагентов;
- редактирование и служебные инструменты.

Отдельно сравнить физический размер всей сохраненной истории с активным контекстом после последней compaction.

## 3. Качественный анализ

- Найти самые дорогие результаты и определить, содержали ли они уникальные сведения.
- Проверить повторные чтения, поиски и команды.
- Проверить, продолжала ли основная модель делать широкую разведку после отчетов субагентов.
- Определить, какие данные нужны дословно, какие можно суммировать, а какие безопасно заменить ссылкой на сохраненный результат.

## 4. Проектирование улучшений

Сравнить варианты:

1. Текущий threshold-based pruning с полной очисткой output.
2. Детерминированное сжатие по типу инструмента без отдельного LLM-вызова.
3. Смысловое summary результатов отдельной моделью или субагентом.
4. Внешнее хранилище полного результата плюс короткий descriptor и инструмент повторной загрузки.
5. Более частая передача широкого исследования субагентам.

Для каждого варианта оценить экономию токенов, дополнительную стоимость, задержку, риск потери важных деталей и сложность реализации.

## 5. Проверка и отчет

- Перепроверить ключевые агрегаты независимыми SQL/скриптовыми запросами.
- Сопоставить наблюдения с текущим кодом `SessionCompaction` и `MessageV2.toModelMessagesEffect`.
- Записать в этот файл итоговые метрики и рекомендуемый следующий шаг после завершения исследования.

## Изменяемые файлы

На завершенном этапе аудита изменялись только документы задачи:

```text
tasks/session-context-audit/task.md
tasks/session-context-audit/plan.md
```

Исследуемая SQLite-база всегда остается read-only. После явного выбора отдельного `PROJ-*` пункта разрешены изолированные изменения продуктового кода и tests, перечисленные в соответствующем разделе.

## Результаты аудита

### Анализ использования контекста

```text
281k активного prompt
├── ~240k tool outputs
│   ├── ~127k bash
│   │   └── ~111k успешные Maven-запуски
│   ├── ~93k read
│   │   ├── ~65.5k Java-код
│   │   └── ~27.5k документы
│   └── ~20k остальные tools
├── ~29k аргументы tool calls
└── ~12k системный prompt, сообщения и прочий overhead
```

### Эффект compaction

До compaction prompt достигал `355 767` токенов. Первый обычный provider turn после готового summary использовал только:

```text
input + cache read = 15 617 tokens
```

То есть compaction сократила активный prompt примерно на 95.6% и сработала эффективно. Затем за семь пользовательских сообщений после compaction накопилось 84 assistant turns, и prompt снова вырос до `281 483` токенов.

Проблема не в неработающей compaction, а в высокой скорости повторного накопления tool history между compactions.

### Использование субагентов

У сессии было 10 дочерних сессий: четыре `explore` и шесть `general`. Они выполняли архитектурную разведку, составляли migration maps и делали review изменений. Их полные внутренние tool histories не попадали в родительский контекст.

В родительской сессии сохранилось около `70k` символов итоговых `task` reports. В активном контексте после compaction оставалось только около `18.7k` символов таких отчетов. Это значительно меньше, чем `bash` и `read`.

Вывод: субагенты использовались правильно и уже дали большую экономию. Увеличение их количества не устранит основную проблему. Дополнительно стоит делегировать:

- широкую разведку call graph и usages;
- анализ больших неуспешных build/test logs;
- полный review большого diff.

Не стоит создавать субагента для каждого обычного чтения, небольшого изменения или успешного теста: стоимость координации и отдельного provider flow станет выше пользы.

### Что сделал бы текущий pruning

Симуляция текущего `SessionCompaction.prune` при `compaction.prune=true` показала:

```text
tool calls marked compacted: 59
estimated removable output: 77 850 tokens
estimated saving after markers: about 77 378 tokens
```

При контексте около `281k` это могло бы уменьшить следующий prompt примерно до `204k` токенов. Это полезно, но не решает все проблемы:

- output заменяется общим marker без смыслового summary;
- tool-call input, включая большие `apply_patch`, сохраняется;
- ссылка на сохраненный полный output не показывается модели после замены;
- pruning запускается после завершения run loop, а не после каждого provider turn;
- старые `task` reports обрабатываются так же, как низкоплотные success logs;
- pruning по умолчанию выключен.

В исследованных project/global config не найдено переопределений `compaction.prune` и `tool_output`, поэтому использовались значения по умолчанию: pruning выключен, shell preview ограничен `50 KiB` и `2000` строками.

## Рекомендуемое направление

### Ближайший практический эксперимент

Без изменения продуктового кода можно отдельно обсудить и затем вручную проверить:

1. Включение `compaction.prune`.
2. Уменьшение `tool_output.max_bytes` примерно до `8-12 KiB`.
3. Уменьшение `tool_output.max_lines` примерно до `300-500` строк.
4. Короткий формат отчетов субагентов: решения, findings, `file:line`, команды проверки, без больших code dumps.

Shell tool сохраняет хвост output, поэтому при меньшем лимите итог команды и последние диагностические строки останутся видимыми. Полный output будет сохранен во внешний файл и доступен через точечный `read`/`grep` до истечения retention. Maven-логи в родительскую сессию больше не попадают: Maven-команды выполняет `general` по глобальной инструкции.

### MVP типизированного вытеснения tool results

MVP не выполняет semantic summary произвольного текста. Он детерминированно заменяет старый полный tool result короткой контекстной проекцией и оставляет модели способ повторно получить оригинал. Отдельный LLM или субагент для построения проекции не нужен.

Проектор должен получать не только строку `state.output`, а полный `ToolPart`:

```text
tool name
call ID
state.status
state.input
state.output
state.metadata
state.attachments
state.time
```

Это позволяет строить карточку из структурированных input и metadata, не пытаясь понять смысл произвольного текста.

Используемые ниже термины:

| Термин | Значение |
|---|---|
| Полный результат | Исходный tool result, сохраненный в SQLite или отдельном файле |
| Контекстная проекция | Короткая карточка, которую модель получает вместо старого полного результата |
| Artifact | Отдельный файл с полным большим результатом, например полным логом команды |
| Защищенный результат | Результат, который обычный pruning не имеет права заменять проекцией |

Ответственность нужно разделить на три части:

| Компонент | Ответственность |
|---|---|
| `PruneSelector` | Выбирает старые tool results, которые пора убрать из активного контекста |
| `ToolResultContextProjector` | По полному `ToolPart` создает детерминированную короткую проекцию |
| `ToolOutputRepository` | По `callID` безопасно возвращает полный исторический результат или сохраненный artifact |

Flow обработки:

```text
tool выполнился
        ↓
полный ToolPart сохранен
        ↓
результат некоторое время остается в активном контексте полностью
        ↓
PruneSelector выбирает его для вытеснения
        ↓
ToolResultContextProjector строит короткую проекцию
        ↓
модель получает проекцию вместо полного output
        ↓
при необходимости модель запрашивает оригинал через tool_output
```

Политика проекции зависит от назначения инструмента:

| Инструмент | Какие структурированные данные доступны | Контекстная проекция MVP | Как получить детали снова |
|---|---|---|---|
| `bash` | command, workdir, exit code, termination, truncated, outputPath, сохраненный tail | Bounded command, workdir, result/exit, короткий success tail или увеличенный diagnostic tail и ссылка по `callID` | `tool_output` проверяет ownership по session и `callID`, потоково читает managed artifact или SQLite и поддерживает range/literal pattern |
| `read` | filePath, offset, limit, фактически прочитанный диапазон, total lines | Путь и диапазон строк с указанием, что старое содержимое вытеснено | Повторить `read` для актуального файла или запросить исторический result через `tool_output` |
| `grep` | pattern, path, include, количество совпадений | Pattern, каталог, include и количество совпадений. Старый список после изменения кода считается потенциально устаревшим | Повторить `grep` или запросить исторический result через `tool_output` |
| `glob` | pattern, path, количество найденных файлов | Маска, каталог и количество файлов | Повторить `glob` или запросить исторический result через `tool_output` |
| `todowrite` | Новый структурированный todo list | Оставить последнее состояние; старые снимки заменить marker о том, что они вытеснены новым состоянием | Использовать последний актуальный todo list |
| `task` | Prompt субагента, child session и финальный отчет | Не строить проекцию: полностью защитить итоговый отчет | Повторная загрузка не требуется |
| `skill` | Загруженные инструкции skill | Не строить проекцию: полностью защитить инструкции | Повторная загрузка не требуется |
| Неизвестный или plugin tool | tool name, callID, input, output и общая metadata | Универсальная карточка: tool завершен, полный output вытеснен, указан `callID` | Запросить полный result через `tool_output` |

Таблица выше остается обзорной матрицей предполагаемой политики, но не считается готовой спецификацией. Каждая строка теперь является отдельным пунктом плана: сначала исследуем фактический контракт и назначение инструмента, затем уточняем политику, и только после этого реализуем и проверяем ее. Это важно, потому что одинаковое возрастное pruning-правило не подходит одновременно для командного лога, содержимого файла, поисковой выдачи, состояния todo list и итогового отчета субагента.

### План исследования и реализации по инструментам

Каждый пункт выполняется отдельным законченным циклом:

```text
исследовать фактические ToolPart input/output/metadata
        ↓
описать, какие сведения обязательны в активном контексте
        ↓
зафиксировать формат проекции и способ повторной загрузки
        ↓
реализовать отдельную policy/projector
        ↓
проверить экономию, восстановление деталей и отсутствие потери поведения
```

Не нужно заранее делать один универсальный projector с большим `switch`, пока не исследованы контракты отдельных инструментов. Общий registry и интерфейс проектора следует извлекать из первых реализованных политик, а не проектировать по предположениям.

<a id="proj-1"></a>
#### PROJ-1. `bash`: результат выполнения команды

- [x] Исследовать фактические `state.input`, `state.output` и `state.metadata` для успешной команды, ненулевого exit code, timeout, abort и усеченного output.
- [x] Проверить жизненный цикл `outputPath`: где хранится полный лог, каков retention и остается ли файл доступным после restart.
- [x] Разделить политики успешного короткого результата, успешного большого лога и ошибки. Для ошибки нужно сохранять больший диагностический tail.
- [x] Зафиксировать проекцию: command, workdir, exit code, статус truncation, короткий tail и retrievable `callID`.
- [x] Реализовать `bash` projector и получение полного результата через `tool_output`.
- [x] Проверить на успешном test/build, failing test, большом логе и удаленном artifact.

Исследование выполнено на read-only данных session `9945` и подтверждено текущим кодом shell tool:

```text
bash ToolPart: 278
├── exit=0, not truncated: 254
├── exit=0, truncated:      19
├── exit=1, not truncated:  2
├── exit=1, truncated:      2
└── exit=128:               1
```

Все `21` усеченных результата имели `metadata.outputPath`, и на момент исследования все соответствующие artifacts существовали. Timeout и abort в session `9945` не встретились, поэтому их контракт проверяется отдельными code fixtures.

Зафиксированный контракт хранения:

| Сценарий | Статус ToolPart | Authoritative full output | Что остается после projection |
|---|---|---|---|
| Успешная короткая команда | `completed`, `exit=0` | `state.output` в SQLite | Descriptor и короткий tail |
| Успешный большой output | `completed`, `exit=0`, `truncated=true` | Artifact из `metadata.outputPath` | Descriptor, короткий tail и `callID` |
| Ненулевой exit code | `completed`, `exit!=0` | SQLite или artifact | Descriptor и увеличенный diagnostic tail |
| Timeout | `completed`, `exit=null` | SQLite или artifact | Причина `timeout` и увеличенный diagnostic tail |
| Abort/interruption | Обычно partial/error flow; возможен `exit=null` | Сохраненный partial output | Причина `aborted` и увеличенный diagnostic tail |
| Artifact удален retention cleanup | Исходный ToolPart остается | Полный output больше недоступен | Явный incomplete marker и сохраненный SQLite preview |

##### Где физически находится результат `bash`

У одного запуска `bash` могут одновременно существовать три похожих значения. Они нужны для разных задач и не являются тремя равноценными копиями результата:

| Место | Когда создается | Что содержит | Для чего используется |
|---|---|---|---|
| `state.metadata.output` | Обновляется много раз, пока команда еще выполняется | Только последние примерно `30 000` символов, которые shell успел получить к этому моменту | Показать live progress в интерфейсе |
| `state.output` | Фиксируется после завершения команды и сохраняется внутри ToolPart в SQLite | Полный output, если он поместился в лимиты; иначе marker, путь к artifact и сохраненный tail | Исторический результат сессии и fallback, если artifact уже удален |
| Файл artifact | Создается только тогда, когда полный output не помещается в лимиты | Полный исходный stdout/stderr без контекстного сокращения | Повторно загрузить нужные строки большого результата через `tool_output` |

На текущей машине `$OPENCODE_DATA` соответствует:

```text
/home/arbocdi/.local/share/opencode
```

Поэтому artifacts находятся примерно здесь:

```text
/home/arbocdi/.local/share/opencode/tool-output/tool_*
```

Под **authoritative source** здесь понимается источник, в котором находится наиболее полная сохранившаяся версия результата. Выбор источника выполняется так:

```text
tool_output получает callID
        ↓
находит bash ToolPart только внутри текущей session
        ↓
state.metadata.truncated == false ?
        │
        ├── да  → полный результат берется из state.output в SQLite
        │
        └── нет → проверяется managed artifact из metadata.outputPath
                         │
                         ├── файл существует → полный результат читается из artifact
                         │
                         └── файл удален      → возвращается только state.output из SQLite
                                                  с complete=false
```

`state.metadata.output` в эту схему получения исторического результата намеренно не входит. Это live preview, а не надежная копия. Например, команда могла вывести `45 000` символов: такой результат еще может полностью поместиться в `state.output`, но `state.metadata.output` уже будет содержать только последние примерно `30 000` символов. Если принять metadata preview за полный результат, первые `15 000` символов незаметно потеряются.

Пример короткой команды:

```text
command: git diff --check
final output: 3 строки

state.metadata.output → последние полученные строки для live UI
state.output          → все 3 строки, сохраненные в SQLite
artifact              → не создается
```

В этом случае после restart полный результат по-прежнему доступен из SQLite через `state.output`.

Пример большого лога:

```text
command: большой build/test
final output: 2 MiB

state.metadata.output → только последние ~30k символов для live UI
state.output          → marker об усечении + outputPath + ограниченный tail
artifact              → полные 2 MiB
```

В этом случае `tool_output` потоково читает artifact и возвращает только запрошенные строки. Весь файл целиком в память и в prompt не загружается.

Artifact является обычным файлом в persistent data directory, поэтому restart opencode его не удаляет. Cleanup хранит такой файл `7` дней, после чего может удалить. SQLite ToolPart при этом остается:

```text
до cleanup:    tool_output → полный artifact, complete=true
после cleanup: tool_output → сохраненный marker/tail из state.output, complete=false
```

Важно: обычный context pruning тоже не стирает `state.output` из SQLite. Он устанавливает `state.time.compacted`, после чего provider вместо старого полного output получает короткую projection. Это экономит prompt, но сохраняет durable данные сессии до обычного удаления самой сессии или artifact retention cleanup.

Зафиксированный формат projection:

```text
Tool bash completed.
Command: <bounded command>
Workdir: <explicit workdir or session directory>
Result: succeeded | failed | timed out | aborted | unknown
Exit code: <number or unavailable>
Original output truncated: yes | no
Recent output:
<short tail for success, larger tail for failure>
Historical output: tool-result://<callID>
Use tool_output with this callID and offset/limit or pattern to inspect details.
```

`tool_output` принимает `callID`, но не принимает filesystem path. Repository сначала ищет bash ToolPart с таким `callID` и `sessionID` текущего tool context. Только после ownership check разрешено прочитать `metadata.outputPath`, причем canonical path дополнительно должен находиться внутри canonical managed `tool-output` directory. Для line-range используются `offset/limit`; при literal `pattern` те же параметры означают offset/limit по найденным совпадениям.

Результат реализации:

```text
packages/opencode/src/session/tool-result-context.ts
packages/opencode/src/tool/output-repository.ts
packages/opencode/src/tool/output.ts
packages/opencode/src/tool/output.txt
```

- `MessageV2.toModelMessagesEffect(...)` заменяет старый generic marker на специализированную bash projection только для compacted bash results.
- Остальные инструменты до своих `PROJ-*` этапов продолжают получать старый marker.
- Shell metadata для новых результатов содержит `termination: exit | timeout | abort`; старые записи поддерживаются через ограниченный fallback внутри `<shell_metadata>`.
- `ToolOutputRepository` фильтрует SQLite одновременно по `sessionID`, `tool=bash` и `callID`; duplicate `callID` считается неоднозначным и не читается.
- Artifact path никогда не приходит от модели. Repository сравнивает `realPath` файла с `realPath` managed directory и не следует через symlink наружу.
- Artifact сканируется потоково. В память сохраняются только выбранные строки в пределах `max_lines` и `max_bytes`.
- `pattern` является case-sensitive literal substring, а не JavaScript regex, поэтому model-controlled ReDoS отсутствует.
- При истекшем или удаленном artifact возвращается SQLite preview с `complete=false`.

Проверки реализации:

```text
bun typecheck: passed
bun test test/session/message-v2.test.ts test/session/tool-result-context.test.ts test/tool/output.test.ts test/tool/registry.test.ts test/tool/shell.test.ts --max-concurrency=4: 87 pass, 0 fail
```

Focused tests покрывают success, nonzero exit, timeout, abort, compaction projection, session ownership, duplicate `callID`, managed artifact, missing artifact, path outside managed directory, symlink escape, multi-chunk streaming selection, literal pattern и низкие `max_lines/max_bytes`.

Read-only замер на session `9945` через актуальные `ToolResultContextProjector.project(...)` и `Token.estimate(...)`:

| Scope | Bash results | Original tokens | Projection tokens | Экономия |
|---|---:|---:|---:|---:|
| Все completed bash results | 278 | 374 184 | 39 919 | 89.33% |
| Только `exit=0` | 273 | 347 415 | 38 480 | 88.92% |
| Diagnostic `exit!=0/null` | 5 | 26 769 | 1 439 | 94.62% |
| Bash subset, выбранный симуляцией текущего pruning | 83 | 19 934 | 11 172 | 43.96% |

Максимальная projection во всей session: `1 750` символов, примерно `438` токенов. Повторная projection одного ToolPart дала идентичную строку.

Момент prompt-cache invalidation относительно текущего pruning не изменился: raw output заменяется projection только после установки `part.state.time.compacted`. При первом запуске новой версии уже compacted bash prefixes изменятся с generic marker на новую детерминированную projection и один раз потеряют старый cache prefix; последующие replay стабильны, пока ToolPart и код projector не меняются.

Критерии `PROJ-DOD` для `PROJ-1` выполнены:

- [x] Full result остается в SQLite или managed artifact; истечение artifact явно отражается через `complete=false`.
- [x] Provider-пара tool-call/tool-result сохраняется существующим `MessageV2` flow.
- [x] Ownership проверяется по session и `callID`; arbitrary path от модели не принимается.
- [x] Есть tests для projection, pruning conversion и повторной загрузки.
- [x] Token savings измерены на read-only данных session `9945`.
- [x] Prompt-cache impact сопоставлен с текущим batch `time.compacted` transition.

<a id="proj-2"></a>
#### PROJ-2. `read`: чтение файла или сохраненного результата

- [ ] Исследовать, какие диапазоны строк и сведения о размере файла реально находятся в input, output и metadata.
- [ ] Разделить два смысла: повторное чтение актуального файла и получение исторического content, который модель видела раньше.
- [ ] Определить поведение для измененного, перемещенного или удаленного после чтения файла.
- [ ] Зафиксировать проекцию: file path, фактически прочитанный диапазон, total lines и ссылки на historical result.
- [ ] Реализовать `read` projector без автоматического сохранения старого текста в проекции.
- [ ] Проверить повторный `read` актуального файла и загрузку исторического result через `tool_output`.

<a id="proj-3"></a>
#### PROJ-3. `grep`: содержательный поиск

- [ ] Исследовать структуру input и возможность надежно получить количество совпадений без повторного разбора произвольного output.
- [ ] Определить, какие сведения нужны для воспроизводимости поиска: pattern, path, include и дополнительные flags.
- [ ] Зафиксировать, что старая выдача является историческим снимком и после изменения файлов может быть устаревшей.
- [ ] Зафиксировать проекцию: параметры поиска, количество совпадений, truncation и retrievable `callID`.
- [ ] Реализовать `grep` projector.
- [ ] Проверить поиск без совпадений, короткую выдачу, большую/усеченную выдачу и повторный поиск после изменения файла.

<a id="proj-4"></a>
#### PROJ-4. `glob`: поиск файлов по маске

- [ ] Исследовать структуру input/output и надежность вычисления количества найденных путей.
- [ ] Определить, нужно ли сохранять небольшой список путей целиком или всегда оставлять только количество и historical result.
- [ ] Зафиксировать проекцию: pattern, root path, количество результатов, truncation и retrievable `callID`.
- [ ] Реализовать `glob` projector.
- [ ] Проверить пустой результат, короткий список, большую выдачу и повторный glob после изменения дерева файлов.

<a id="proj-5"></a>
#### PROJ-5. `todowrite`: состояние плана выполнения

- [ ] Исследовать, где хранится authoritative последнее состояние todo list и как старые вызовы представлены в model messages.
- [ ] Определить правило supersession: новый успешный `todowrite` делает предыдущий snapshot устаревшим, но не должен скрывать последнее состояние.
- [ ] Определить поведение для failed/aborted вызова, который не должен вытеснять предыдущий успешный список.
- [ ] Реализовать защиту последнего успешного состояния и компактный marker для superseded snapshots.
- [ ] Проверить несколько последовательных обновлений, ошибку обновления и compaction между обновлениями.

<a id="proj-6"></a>
#### PROJ-6. `task`: итоговый отчет субагента

- [ ] Исследовать completed, failed, interrupted и background task results, а также связь `callID` с child session.
- [ ] Подтвердить, что foreground completed result действительно является уже сжатым итоговым отчетом, а не полной внутренней историей субагента.
- [ ] Зафиксировать политику защиты completed report и отдельное поведение для очень большого или неуспешного отчета.
- [ ] Реализовать защиту `task` result от обычного возрастного pruning.
- [ ] Проверить сохранение отчета после нескольких provider turns, pruning и compaction.

<a id="proj-7"></a>
#### PROJ-7. `skill`: загруженные инструкции

- [ ] Исследовать, как skill output включается в последующие model messages и может ли skill быть безопасно загружен повторно.
- [ ] Подтвердить существующую защиту `skill` и определить, нужна ли дедупликация нескольких загрузок одного skill.
- [ ] Зафиксировать, какие идентификаторы skill должны оставаться в контексте вместе с полными инструкциями.
- [ ] Реализовать только недостающую защиту или дедупликацию, не заменяя инструкции кратким summary.
- [ ] Проверить один skill, повторную загрузку и несколько разных skills перед pruning/compaction.

<a id="proj-8"></a>
#### PROJ-8. Неизвестный или plugin tool: безопасная fallback-политика

- [ ] Исследовать минимальные гарантии общего `ToolPart`, доступные без знания plugin-specific schema.
- [ ] Определить fail-safe поведение для результата без `callID`, с attachments или с metadata неизвестной формы.
- [ ] Зафиксировать универсальную проекцию: tool name, completion status, короткий bounded preview и retrievable `callID`, если он доступен.
- [ ] Не разрешать generic projector удалять данные, которые нельзя повторно получить или безопасно описать.
- [ ] Реализовать fallback только после специализированных policies, чтобы он не перехватывал известные инструменты.
- [ ] Проверить synthetic plugin tools с коротким, большим, бинарным/attachment и unretrievable результатом.

<a id="proj-dod"></a>
### PROJ-DOD. Общие критерии готовности каждого пункта

- [ ] Полный исходный result остается durable или явно документируется как невосстановимый.
- [ ] Проекция сохраняет корректную provider-пару tool-call/tool-result.
- [ ] `tool_output` проверяет принадлежность `callID` текущей сессии и не раскрывает результат другой сессии.
- [ ] Есть tests для projection, pruning selection и повторной загрузки деталей.
- [ ] Измерена экономия токенов на representative fixture или копии структуры session `9945` без изменения исходной SQLite-базы.
- [ ] Проверено влияние пакетной замены старого prefix на provider prompt cache.
- [ ] Результаты исследования и окончательный контракт обновлены в таблице до начала реализации следующего инструмента.

Maven отдельно обрабатывать в родительской сессии не нужно: по принятому правилу Maven-команды выполняет `general`, а родитель получает короткий защищенный `task` report.

Пример проекции старого `bash` result:

```text
Tool bash completed.
Command: git diff --check
Exit code: 0
Full historical result: tool-result://call_123
Use tool_output with offset/limit or pattern to inspect it.
```

Пример проекции старого `read` result:

```text
Previously read: /project/CloseLeadService.java, lines 1-300.
Old file content removed from active context.
Historical result: tool-result://call_456
Call read again if the current file content is needed.
```

`tool_output` принимает `callID`, проверяет принадлежность вызова текущей сессии и возвращает только запрошенный диапазон `offset/limit` или совпадения `pattern`. Для обычного результата оригинал уже остается в SQLite. Для ранее усеченного `bash` result в SQLite находится marker и tail, поэтому repository использует сохраненный в metadata внутренний `outputPath` для доступа к полному файлу.

Сжатие tool-call inputs не входит в MVP. Особенно это относится к `apply_patch`: основная часть его размера находится в `state.input` с полным patch, а не в коротком output. Изменение исторических tool-call arguments требует отдельного проектирования из-за корректности пары tool-call/tool-result и provider prompt cache.

### Принятое решение: защищать отчеты субагентов

Завершенный foreground-субагент возвращает итоговый отчет в родительскую сессию как output инструмента `task`. Текущий pruning не отличает этот отчет от обычного `bash` или `read` output и может заменить его на общий marker, потому что сейчас явно защищен только инструмент `skill`.

В первой реализации умного pruning результаты `task` нужно защищать наравне с `skill`:

```ts
const PRUNE_PROTECTED_TOOLS = ["skill", "task"]
```

Причины:

- полный исследовательский flow уже изолирован в дочерней сессии;
- в родительскую сессию попадает только итоговый сжатый отчет;
- такой отчет содержит решения, найденные связи, риски и точные `file:line`, то есть имеет высокую смысловую плотность;
- после очистки output в родительском контексте останется prompt запуска, но исчезнет полученный результат;
- в сессии `9945` активные `task` reports занимали только около `4.7k` токенов против примерно `127k` у `bash` и `93k` у `read`, поэтому их pruning дает небольшую экономию при высоком риске потери полезной информации.

Если отдельный отчет субагента окажется слишком большим, ограничивать его нужно до сохранения в родительский контекст: требовать краткий формат или сохранять полный отчет как artifact с компактным summary. Обычный возрастной pruning уже сохраненного `task` output для этого использовать не следует.

Проверка будущей реализации должна подтверждать:

```text
старый completed bash output  -> может быть pruned
старый completed read output  -> может быть pruned
старый completed skill output -> остается доступным
старый completed task output  -> остается доступным
```

### Почему не автоматический LLM-summary для всего

Автоматический субагент или LLM-summary для каждого tool result добавит:

- дополнительный provider call;
- latency и стоимость;
- риск исказить имя файла, строку ошибки или точное значение;
- еще один текстовый результат, который тоже придется хранить и pruning-овать.

LLM-summary стоит оставить для редких больших и семантически сложных данных: неуспешных логов, внешней документации и исследовательских отчетов. Успешные тесты, `glob`, `grep`, `todowrite` и большинство `read` лучше сжимать детерминированно.

### Жизненный цикл

Целевая модель:

```text
hot  -> полный недавний result, который модель еще использует
warm -> компактный descriptor + retrievable artifact
cold -> compaction summary; artifact может быть удален по retention
```

Переход `hot -> warm` следует делать пакетно и только после того, как модель хотя бы один раз получила result. Нужно сохранять корректную пару tool-call/tool-result и учитывать, что изменение старого prefix сбрасывает provider prompt cache. Поэтому переходы выгоднее выполнять порогами, как текущий `PRUNE_MINIMUM`, а не после каждого маленького вызова.
