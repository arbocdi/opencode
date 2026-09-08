# План диагностики и исправления

## Выполненное исследование

1. Проверить актуальный runtime-лог `/home/arbocdi/.local/share/opencode/log/opencode.log`.
2. Сопоставить provider, model, session ID, время начала запроса и время ошибки.
3. Отличить пользовательское прерывание от автоматического timeout:
   - пользовательское прерывание содержит событие `message=cancel`, затем `error=Aborted`;
   - автоматическое прерывание содержит `stream error` с `Provider response headers timed out after 10000ms` без предшествующего `message=cancel`.
4. Проследить обработку ошибки от `AbortController` до текста `Прервано` в UI.
5. Проверить глобальную конфигурацию provider timeout-параметров.
6. Сопоставить локальный код с GitHub issue `#29548` и исправляющим PR `#37770`.

## Ключевые локальные места

- `packages/opencode/src/provider/provider.ts`
  - задает стандартный `OPENAI_HEADER_TIMEOUT_DEFAULT`;
  - создает timeout AbortController;
  - объединяет timeout signal с signal текущего запроса.
- `packages/opencode/src/session/message-v2.ts`
  - преобразует `DOMException` с именем `AbortError` в `MessageAbortedError`;
  - отдельно умеет преобразовывать типизированный `HeaderTimeoutError` в retryable `APIError`, но transport возвращает наружу `AbortError`, поэтому в исследованных случаях срабатывает более общий abort mapping.
- `packages/opencode/test/provider/header-timeout.test.ts`
  - фиксирует ожидаемое стандартное значение timeout.
- `packages/ui/src/i18n/ru.ts`
  - переводит interrupted-состояние как `Прервано`.
- `/home/arbocdi/.config/opencode/opencode.jsonc`
  - содержит timeout-параметры только для `openai-api`, а проблемные запросы используют `openai`.

## Примеры из логов

### Автоматический header timeout

```text
2026-08-10T05:23:20.611Z stream providerID=openai modelID=gpt-5.6-sol-fast
2026-08-10T05:23:30.664Z stream error ... AbortError: Provider response headers timed out after 10000ms
```

Между началом запроса и ошибкой прошло примерно 10 секунд. События `message=cancel` перед ошибкой нет.

### Перегрузка OpenAI

```text
2026-08-10T08:34:47.261Z stream providerID=openai modelID=gpt-5.6-sol-fast
2026-08-10T08:34:57.839Z service_unavailable_error code=server_is_overloaded
```

Этот ответ приходит непосредственно от provider и подтверждает внешнюю перегрузку.

### Настоящее пользовательское прерывание

```text
2026-08-10T05:04:31Z message=cancel
2026-08-10T05:04:31Z error=Aborted
```

Здесь наличие `message=cancel` позволяет отличить ручную отмену от provider timeout.

## Реализованное минимальное изменение кода

По решению пользователя timeout увеличен до 45 секунд:

1. В `packages/opencode/src/provider/provider.ts` `OPENAI_HEADER_TIMEOUT_DEFAULT` изменен с `10_000` на `45_000`.
2. В `packages/opencode/test/provider/header-timeout.test.ts` ожидаемое значение изменено с `10_000` на `45_000`.
3. Из `packages/opencode` выполнен focused-тест:

```text
bun test test/provider/header-timeout.test.ts --max-concurrency=4
```

Результат: `6 pass`, `0 fail`.

4. При необходимости запустить package-local typecheck:

```text
bun typecheck
```

## Альтернативный workaround в конфигурации

Если не требуется пересборка, timeout необходимо задавать под ключом `openai`, потому что именно этот provider ID указан в runtime-логах. Изменение конфигурации и перезапуск OpenCode выполняются отдельно после подтверждения пользователя.

## Сборка и развертывание

26 августа 2026 года выполнена host-only production-сборка для Linux x64:

```text
PATH="/home/arbocdi/.bun/bin:$PATH" OPENCODE_CHANNEL=dev /home/arbocdi/.bun/bin/bun run script/build.ts --single
```

Рабочий каталог команды: `/work/projects/opencode_src/packages/opencode`.

Результат сборки:

```text
/work/projects/opencode_src/packages/opencode/dist/opencode-linux-x64/bin/opencode
0.0.0-dev-202608261011
```

Build-скрипт успешно выполнил собственный smoke-test `opencode --version`. Сервис `opencode-web.service` запускает бинарник непосредственно по этому пути, поэтому отдельное копирование нового бинарника не требуется.

До перезапуска старый выполняющийся бинарник версии `0.0.0-dev-202608050858` сохранен для rollback:

```text
/home/arbocdi/.local/share/opencode/binary-backups/opencode-0.0.0-dev-202608050858
```

Build-скрипт побочно обновил floating Git-зависимость `ghostty-web` в `bun.lock`. Это изменение не относится к задаче и было удалено из рабочего дерева; собранный бинарник при этом не менялся.

После сборки user-service `opencode-web.service` перезапущен. Итоговая проверка работающего процесса:

```text
ActiveState=active
SubState=running
MainPID=1056137
ExecMainStatus=0
NRestarts=0
HTTP http://127.0.0.1:4096/ -> 200
GET /provider -> openai.options.headerTimeout = 45000
```

В журнале после запуска нет ошибок. Есть штатное предупреждение `OPENCODE_SERVER_PASSWORD is not set`, потому что сервер слушает `0.0.0.0:4096` без пароля; для этой локальной доверенной домашней сети это осознанная текущая конфигурация.

## Важные решения

- Не отключать timeout без необходимости: это вернет бесконечные зависания, описанные в issue `#29079`.
- Использовать выбранные пользователем 45 секунд вместо upstream-значения 300 секунд: это менее длительное ожидание при действительно зависшем запросе, но заметно больше прежних 10 секунд.
- Не менять custom provider `openai-api`: он предназначен для отдельного API-key flow и не является источником исследованных ошибок.
- Не смешивать эту проблему с ошибками orphaned tool calls: в исследованных эпизодах первой причинной ошибкой является response-header timeout до начала stream.

## Текущий статус

Диагностика, изменение runtime-кода, focused-тест, production-сборка и перезапуск сервиса завершены. Стандартный OpenAI header timeout увеличен с 10 до 45 секунд; live provider endpoint запущенного сервиса возвращает `45000`. Пользовательская конфигурация не изменялась.
