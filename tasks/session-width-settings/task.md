# Настройка ширины окна сессии opencode

## Контекст

Мы работаем с форком `opencode` и используем web UI по адресу вида:

```text
http://arbocdi-dev-vm:4096/<project>/session/<session-id>
```

Изначальная проблема выглядела так: рабочая область с сообщениями и нижним prompt в браузере были слишком узкими. Из-за этого длинные ответы, код и большие объяснения занимали много вертикального места и хуже читались.

Сначала мы попробовали настройку `~/.config/opencode/tui.jsonc`, но выяснили важную вещь:

```text
tui.jsonc управляет terminal TUI, а не browser web UI.
```

То есть настройка terminal TUI не могла изменить страницу, открытую в браузере на `:4096`.

## Что сделали

Мы изменили два независимых интерфейса:

1. Terminal TUI получил настройку `session.max_width` в `tui.jsonc`.
2. Browser web UI получил настройку `Session content width` в UI settings.

Основная полезная для нас часть — browser web UI setting.

## Web UI настройка

В web UI добавлена настройка:

```text
Settings -> General -> Appearance -> Session content width
```

Доступные значения:

```text
1000px
1100px
1280px
1440px
1600px
```

Значение по умолчанию:

```text
1280px
```

Настройка влияет на:

- timeline сообщений в сессии;
- нижний composer/prompt в сессии;
- new-session экран с prompt и wordmark.

## Где хранится web UI настройка

Настройка хранится на стороне браузера в persisted app settings.

Практические последствия:

- настройка привязана к браузеру;
- настройка привязана к host/port, например `arbocdi-dev-vm:4096` и `localhost:4096` могут иметь разные browser storage;
- другой браузер увидит дефолтное значение;
- очистка данных сайта сбросит настройку;
- серверная БД сессий не меняется;
- `opencode.json` и `tui.jsonc` для этой настройки не используются;
- после изменения значения в Settings сервер перезапускать не нужно, UI должен применить setting как обычное состояние приложения.

## Terminal TUI настройка

Для terminal TUI добавлена настройка в `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",

  "session": {
    "max_width": 160
  }
}
```

Важно: это не влияет на browser web UI.

## Почему не стали делать через `opencode.json`

Для web UI настройка ширины — это пользовательское визуальное предпочтение конкретного браузера. Поэтому ее логичнее хранить в app settings, а не в серверном конфиге.

Если бы мы положили это в `opencode.json`, то настройка стала бы общей для всех клиентов и окружений проекта. Это хуже для UI-предпочтений, потому что одному человеку удобно `1000px`, другому `1600px`, а на ноутбуке и большом мониторе нужны разные значения.

## Почему использовали preset-значения, а не произвольное число

Мы выбрали список готовых значений:

```text
1000, 1100, 1280, 1440, 1600
```

Причины:

- нельзя случайно ввести `0`, `50` или `99999` и сломать layout;
- проще UI: select вместо number input;
- проще поддерживать и тестировать;
- значения покрывают основные сценарии от умеренно широкого до очень широкого экрана.

## Как проверить вручную

1. Запустить свежесобранный бинарь opencode.
2. Открыть web UI на `http://arbocdi-dev-vm:4096/...`.
3. Открыть `Settings -> General -> Appearance`.
4. Найти `Session content width`.
5. Переключить значение, например с `1280px` на `1600px`.
6. Вернуться в сессию и проверить, что timeline и нижний prompt стали шире.

Если изменений не видно:

- проверить, что запущен свежий бинарь, а не старый `opencode` из PATH;
- сделать hard refresh страницы;
- проверить, что открыт тот же host/port, где менялась настройка;
- помнить, что настройка задает максимум, а не принудительную ширину: если окно браузера уже меньше выбранного значения, визуально расширяться нечему.

## Свежий бинарь после реализации

Последняя успешная сборка в момент документирования:

```text
/work/projects/opencode_src/packages/opencode/dist/opencode-linux-x64/bin/opencode
```

Версия smoke test:

```text
0.0.0-dev-202606260022
```

## Проверки, которые проходили

Для `packages/app`:

```bash
/home/arbocdi/.bun/bin/bun typecheck
/home/arbocdi/.bun/bin/bun test ./e2e/performance/unit
```

Для production benchmark timeline:

```bash
PATH="/home/arbocdi/.bun/bin:$PATH" /home/arbocdi/.bun/bin/bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts
```

Для `packages/opencode`:

```bash
/home/arbocdi/.bun/bin/bun typecheck
```

Сборка opencode с embedded web UI:

```bash
PATH="/home/arbocdi/.bun/bin:$PATH" OPENCODE_CHANNEL=dev /home/arbocdi/.bun/bin/bun run script/build.ts --single
```

Проверка версии бинаря:

```bash
/work/projects/opencode_src/packages/opencode/dist/opencode-linux-x64/bin/opencode --version
```

## Важный operational note

В `packages/app/AGENTS.md` есть правило:

```text
NEVER try to restart the app, or the server process, EVER.
```

Поэтому при работе агент не должен сам перезапускать сервер на `4096`. Пользователь сам останавливает старый процесс и запускает свежий бинарь.
