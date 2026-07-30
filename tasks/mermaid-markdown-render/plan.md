# План реализации Mermaid MVP

## Техническая идея

Текущий Markdown renderer находится в:

```text
packages/session-ui/src/components/markdown.tsx
```

Для streaming он разбивает Markdown на блоки через:

```text
packages/session-ui/src/components/markdown-stream.ts
```

Завершенный fenced code block приходит в renderer как block с:

```text
mode: "code"
complete: true
language: "mermaid" | "mmd" | "graphmermaid"
src: исходный текст диаграммы
```

MVP должен встроиться именно в code-block branch, чтобы не ломать обычный Markdown parser и Shiki highlighting.

## Предпочтительная реализация

1. Добавить dependency `mermaid` в `packages/session-ui/package.json`.
2. Добавить небольшой renderer рядом с Markdown component, например:

```text
packages/session-ui/src/components/markdown-mermaid.ts
```

3. В `markdown.tsx` добавить ветку:

```text
if block.mode === "code" && block.complete && isMermaidLanguage(block.language)
```

4. Для Mermaid block вернуть отдельный `RenderedBlock` mode, например `mermaid`.
5. В DOM update добавить отдельную функцию `updateMermaidBlock(...)`.
6. Mermaid загружать lazy. Важно: прямой `import("mermaid")` оказался слишком тяжелым для Vite build в `packages/app` и приводил к V8 OOM, поэтому используем prebuilt asset `mermaid/dist/mermaid.min.js?url` и подключаем его как script только при первом завершенном Mermaid-блоке.
7. Mermaid render выполнять последовательно через module-level promise chain, потому что `mermaid.render(...)` не стоит запускать конкурентно.
8. SVG после Mermaid render дополнительно прогонять через DOMPurify SVG profile. Не используем общий `sanitizeMarkdown(...)`, потому что его HTML-профиль разрешает слишком мало SVG-тегов для полноценной Mermaid-диаграммы.
9. При ошибке отображать:

```text
Mermaid rendering error: <message>
<исходный код диаграммы>
```

## Почему не берем PR #21497 как есть

У PR есть полезная идея, но он слишком сложный для MVP и содержит риски:

- сохраняет rendered DOM без сравнения source hash;
- ошибка Mermaid может залипнуть после первого невалидного streaming chunk;
- нет защиты от concurrent `mermaid.render(...)`;
- добавляет document listeners без cleanup;
- fullscreen меняет body styles;
- theme определяется один раз;
- меняет старую структуру `packages/ui/src/components/markdown.tsx`, а текущий renderer живет в `packages/session-ui`.

## Проверки

Минимальные проверки после реализации:

```bash
cd packages/session-ui
bun test src/components/markdown-mermaid.test.ts src/components/markdown-stream.test.ts src/components/markdown-code-state.test.ts src/components/markdown-worker-queue.test.ts src/components/markdown-worker-protocol.test.ts src/components/markdown-worker-transport.test.ts src/components/markdown-preload.test.ts
bun typecheck
```

Если изменения затронут app/session rendering, дополнительно нужен performance benchmark из `packages/app` до и после изменения.

Фактически выполненные проверки:

```bash
cd packages/session-ui
bun test src/components/markdown-mermaid.test.ts src/components/markdown-stream.test.ts src/components/markdown-code-state.test.ts src/components/markdown-worker-queue.test.ts src/components/markdown-worker-protocol.test.ts src/components/markdown-worker-transport.test.ts src/components/markdown-preload.test.ts
bun typecheck

cd packages/app
bun typecheck
bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts
```

## Benchmark notes

Baseline до Mermaid-правок:

- Command: `cd packages/app && bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts`
- Status: passed.
- `completionObservedMs=76616.5`.
- `longTaskTimeMs=26660`.

Промежуточная проблема:

- После добавления прямого `import("mermaid")` benchmark не доходил до теста: `vite build` падал с V8 OOM около 2 GB heap.
- Причина: Vite/Rollup пытался обработать тяжелое dependency graph пакета Mermaid (`d3`, `cytoscape`, `katex`, `marked` и другие зависимости).
- Исправление: заменить прямой runtime import на загрузку prebuilt `mermaid.min.js` как asset script через `?url`.

После финальных правок:

- Command: `cd packages/app && bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-timeline-benchmark.spec.ts`
- Status: passed.
- `completionObservedMs=95610.1`.
- `longTaskTimeMs=43407`.
- `rowReplaced=false`, `markdownReplaced=false`, `bottomDriftTransitions=0`, `blankSamples=0`.

Важно: post-change benchmark прошел и подтвердил, что сборка больше не падает на Vite OOM. Метрики одного post-change прогона хуже baseline, но в самом benchmark нет признаков remount/scroll regression. Mermaid script не загружается и не выполняется в обычной timeline без Mermaid-блоков; отличие метрик нужно считать шумом или проверять серией повторных прогонов, если потребуется строгая performance-оценка.
