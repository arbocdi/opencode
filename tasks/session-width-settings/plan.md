# План и технические детали реализации

## Цель

Сделать ширину окна сессии opencode настраиваемой так, чтобы в browser web UI можно было удобно читать длинные ответы и код на широком мониторе.

## Решение по слоям

Изменение разделено на два слоя, потому что в opencode есть два разных UI:

1. Terminal TUI.
2. Browser web UI.

Настройки этих интерфейсов не одинаковые.

## Terminal TUI

### Измененные файлы

```text
packages/tui/src/config/index.tsx
packages/tui/src/routes/session/index.tsx
packages/tui/test/config.test.tsx
```

### Что изменено

Добавлена схема:

```ts
session: {
  max_width?: number
}
```

В `Session` route ширина content теперь считается так:

```text
available = terminal width - sidebar - padding
contentWidth = min(available, tuiConfig.session.max_width ?? available)
```

Это означает:

- если setting не задан, поведение остается как раньше;
- если terminal уже меньше setting, используется доступная ширина;
- отрицательная ширина невозможна, есть clamp до `1`.

## Browser web UI

### Измененные файлы

```text
packages/app/src/context/settings.tsx
packages/app/src/components/settings-general.tsx
packages/app/src/components/settings-v2/general.tsx
packages/app/src/components/session/session-new-design-view.tsx
packages/app/src/i18n/en.ts
packages/app/src/pages/session/composer/session-composer-region.tsx
packages/app/src/pages/session/new-session-layout.ts
packages/app/src/pages/session/timeline/message-timeline.tsx
```

### Setting model

В `packages/app/src/context/settings.tsx` добавлено:

```ts
export const sessionContentWidthOptions = [1000, 1100, 1280, 1440, 1600] as const
export const sessionContentWidthDefault = 1280
```

В `Settings.appearance` добавлено поле:

```ts
sessionContentWidth: number
```

Доступ идет через:

```ts
settings.appearance.sessionContentWidth()
settings.appearance.setSessionContentWidth(value)
```

Значение нормализуется: если в persisted storage лежит неизвестное число, используется дефолт `1280`.

### UI control

Настройка добавлена в два settings UI:

```text
packages/app/src/components/settings-general.tsx
packages/app/src/components/settings-v2/general.tsx
```

Обе версии показывают select в Appearance section.

### Layout application

Раньше ширина была жестко задана Tailwind-классами:

```text
md:max-w-200 2xl:max-w-[1000px]
```

Потом мы временно расширили ее до:

```text
md:max-w-[1100px] 2xl:max-w-[1280px]
```

Финальное решение: убрать hardcoded width class и использовать inline style:

```tsx
style={{ "max-width": `${settings.appearance.sessionContentWidth()}px` }}
```

Такой подход выбран потому, что Tailwind не умеет надежно генерировать dynamic class вида:

```tsx
`max-w-[${value}px]`
```

Если значение известно только в runtime, inline style или CSS variable — правильнее.

## Почему setting находится в Appearance

Ширина контента — визуальная настройка конкретного пользователя и конкретного браузера. Поэтому она находится рядом с theme/font/color settings.

## Почему не меняли публичные README

Это изменение пока относится к нашему форку и локальной задаче. Публичные README opencode не стоит менять до решения, хотим ли мы upstream PR и какой UX/API настройки должен быть принят проектом.

Если будем готовить MR/PR, тогда нужно будет дополнительно:

- написать PR description;
- указать user-visible behavior;
- приложить before/after screenshots;
- добавить release note, если в проекте есть такой процесс;
- решить, нужны ли переводы для всех locale или достаточно английского fallback.

## Benchmark notes

По правилу `packages/app/AGENTS.md` перед изменениями session/timeline кода нужно иметь benchmark baseline.

Baseline после жесткого расширения ширины:

```text
completionObservedMs: 90307.1
longTaskTimeMs: 36038
status: passed
```

После вынесения ширины в setting:

```text
completionObservedMs: 91538.7
longTaskTimeMs: 36710
status: passed
```

Вывод: benchmark прошел, существенной деградации не видно. Разница выглядит как нормальный шум стресс-бенчмарка с CPU throttle.

## Как правильно документировать такие изменения в будущем

Минимальный правильный набор для локальной задачи:

1. `tasks/<task-name>/task.md` — что делали и зачем.
2. `tasks/<task-name>/plan.md` — какие файлы менялись, как проверять, какие команды запускались.
3. Комментарии в коде — только если есть неочевидное ограничение.
4. PR description — если изменение пойдет в upstream/общую ветку.

Для этого изменения code comments почти не нужны: код читается прямо, а подробности лучше держать в task docs.
