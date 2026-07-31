# План снижения потребления памяти OpenCode

## Подтвержденный OOM

Kernel journal содержит событие:

```text
2026-07-31 13:26:08 +03:00
tsgo invoked oom-killer
global_oom
Total swap = 0 kB
Killed process: idea, PID 109930
idea anon-rss: 3 621 164 kB, примерно 3.46 GiB
```

Systemd зафиксировал для unit IntelliJ IDEA peak около `5.7 GiB`. Это был глобальный OOM всей VM, а не превышение cgroup `memory.max`.

Текущие ресурсы VM:

```text
RAM:  15 GiB
CPU:  12 доступных логических CPU
Swap: отсутствует
```

## Причинная цепочка

```text
git push
  -> .husky/pre-push
  -> bun typecheck
  -> bun turbo typecheck
  -> typecheck для всех workspace packages
  -> несколько независимых tsgo одновременно
  -> каждый tsgo загружает собственный TypeScript program/type graph
  -> память tsgo складывается с IDEA, OpenCode и desktop environment
  -> swap отсутствует
  -> свободная RAM заканчивается
  -> kernel global OOM killer завершает IDEA
```

Ядро зафиксировало `tsgo` как процесс, запросивший страницу памяти в момент исчерпания RAM. Это не означает, что один `tsgo` потребил всю память. OOM возник из-за суммы одновременно работающих процессов. Kernel выбрал IDEA как жертву по OOM badness score, размеру процесса и `oom_score_adj=200`.

## Почему typecheck потребляет много памяти

Root script:

```text
package.json: bun turbo typecheck
```

Pre-push hook безусловно вызывает root typecheck:

```text
.husky/pre-push: bun typecheck
```

В monorepo около 35 Turbo packages, примерно 29 из них запускают typecheck. `turbo.json` не задает concurrency limit и dependency ordering для `typecheck`, поэтому Turbo выполняет несколько package tasks одновременно.

Большинство packages запускают отдельный процесс:

```text
tsgo --noEmit
```

`packages/app` и `packages/desktop` используют `tsgo -b`. Desktop также ссылается на app через TypeScript project reference, поэтому параллельные package tasks могут частично дублировать работу с app type graph.

Cache miss означает, что соответствующий `tsgo` действительно запускается. Сообщение `Remote caching disabled` само память не потребляет, но отсутствие подходящего local/remote cache не позволяет пропустить проверку.

## Почему tests потребляют много памяти

Root test специально запрещен, но `bun turbo test` может одновременно запустить тесты нескольких packages и dependency builds.

Внутри одного Bun test process параметр `--max-concurrency` по умолчанию равен `20`. Если package tests используют concurrent tests, высокий лимит увеличивает одновременно живущие fixtures и данные.

App browser/e2e tests дополнительно используют Happy DOM или Playwright browser workers. Playwright может держать несколько browser processes; для CI в app явно задано до пяти workers.

## Почему build потребляет много памяти

Build packages может параллельно запускать Vite, Electron Vite и другие bundlers. Bundler держит в памяти module graph, преобразованный код, chunks и sourcemaps. App и desktop builds генерируют sourcemaps, а desktop prebuild также собирает OpenCode sidecar.

## Безопасные ограничения

Эти варианты сохраняют смысл проверок, но уменьшают параллелизм:

```bash
bun turbo typecheck --concurrency=2
bun turbo build --concurrency=2
bun turbo test --concurrency=2
```

Для package-local Bun tests:

```bash
bun test --only-failures --max-concurrency=4
```

Для app Playwright:

```bash
PLAYWRIGHT_WORKERS=1 bun --cwd packages/app test:e2e:local
```

Начальное безопасное значение для VM с `15 GiB`, IDEA и запущенным OpenCode — Turbo concurrency `2`. После измерения peak RSS его можно увеличить до `3` или `4`.

## Возможные изменения репозитория

Не реализовано, требуется отдельное решение:

1. Изменить pre-push typecheck на `bun turbo typecheck --concurrency=2`.
2. Либо добавить top-level Turbo setting `"concurrency": "25%"`, что на 12 CPU даст примерно три одновременные задачи и затронет все Turbo workflows.
3. Для локальных итераций запускать `bun typecheck` только из измененного package, оставляя полный ограниченный typecheck для pre-push.
4. Не удалять локальный Turbo cache без причины: cache hit предотвращает повторный запуск тяжелого task.

Не рекомендуется использовать `git push --no-verify` как постоянное решение: это полностью пропускает pre-push validation.

## Возможные изменения VM

Не выполнено, системную настройку делает пользователь интерактивно:

1. Добавить swap как страховку от global OOM. Для development VM с `15 GiB` RAM разумно отдельно обсудить swapfile размером `8-16 GiB`.
2. Swap не заменяет ограничение concurrency: при большом рабочем наборе система начнет активно переносить страницы на диск и может сильно тормозить.
3. При необходимости ограничить build/typecheck отдельным systemd cgroup, чтобы OOM завершал проверку, а не IDEA или весь desktop session.
4. Проверить и при необходимости уменьшить heap IntelliJ IDEA: сейчас IDEA является крупнейшим постоянным потребителем RAM.

## Рекомендуемый порядок

```text
1. Ограничить Turbo concurrency до 2 для pre-push typecheck.
2. Ограничить package/test worker concurrency.
3. Добавить swap как системную страховку.
4. Измерить peak memory на следующей полной проверке.
5. Только после измерения повышать concurrency.
```
