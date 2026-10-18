# Состояние миграции на TypeScript

Проверено 2026-10-13 по рабочему дереву, включая текущие неигнорируемые новые файлы.
Числа ниже — датированный снимок, а не ограничение на дальнейшее развитие проекта.
Актуальные пути перечисляет `node tools/migrationInventory.mts --json`.

## Остаток JavaScript

| Область | JS/MJS | Vue с script без `lang="ts"` |
| --- | ---: | ---: |
| `web/src` | 44 | 40 |
| `server/src` | 7 | — |
| `server/scripts` | 1 | — |
| `web/scripts` | 17 | — |
| `web/vite.config.js` | 1 | — |
| `web/public` | 1 | — |
| `tools` | 8 | — |
| `engine` | 2 | — |
| `tests`, включая helpers и fixtures | 933 | Отдельные намеренные образцы |
| `shared`, product-код `mobile`, `relay`, `desktop` | 0 | 0 |

Всего 1014 JS/MJS. `remainingBeyondCompatibility()` вычитает семь поимённых исключений
и возвращает 1007 путей; 40 Vue считаются отдельно. Набор JS совпал с независимым
перечислением через `git ls-files --cached --others --exclude-standard`.

Основной продуктовый остаток — точка входа web, router, 17 stores, функции речи,
часть shared/helpers и крупные Vue: `ChatSession`, `PipelineView`,
`TaskModal`, `BoardView`, `AppShell`. Новые JS-helper сервера:
`server/src/lib/pluginInstall/commandSupervisor.mjs` и `gitBlobPrefix.mjs`.

Зависимости, build output и приватное состояние не являются предметом переноса.
Пять JS-SFC в `tests/web/fixtures/ui` перечислены в `COVERAGE_EXCEPTIONS` и намеренно
проверяют правила компонентов: это не те 40 Vue продукта.

## Что означает зелёная проверка типов

Восемь команд завершились с кодом 0: `typecheck` в server, web, mobile, relay, desktop;
`typecheck:tests` в server и web; `typecheck:scripts` в web. Четыре теста
`tests/docs/migration-inventory.test.mts`, запущенные через memory guard, прошли.
Снимок совпал с baseline, `typecheckDebt` пуст, `uncheckedTypeScript()` пуст в границах
текущего инвентаризатора. Полный offline suite, сборка и browser smoke этим аудитом
не проверялись.

Это не означает завершённую миграцию:

- Общие server/web конфигурации, проекты их тестов и web scripts используют
  `allowJs: true`, `checkJs: false`: JavaScript не получает собственных диагностик.
- После переноса настроек (проверка 2026-10-19) `web/tsconfig.json.exclude` содержит
  34 пути Vue: 33 существующих компонента и прежний отсутствующий `views/LoginView.vue`.
  Три существующих Vue с JS-script не названы там: `views/ExtPluginView.vue`,
  `views/pipeline/BootstrapDecision.vue`, `views/pipeline/DeferredFindings.vue`.
  Страницы общего модала, включая `views/settings/pages/SystemPage.vue`, используют TS.
  Исключение из начального набора файлов не запрещает транзитивные импорты.
- `web/src/shared/chatApprovals.d.ts` описывает узкий контракт соседнего JS-adapter,
  но не проверяет реализацию `web/src/stores/chat.js`.
- В собственных TS/MTS и TS-script Vue вне tests найдено 77 явных типов `any`
  в 23 файлах. Подсчёт сделан по TypeScript AST, без комментариев и строковых литералов.
  Самые большие группы: `server/src/lib/analysis/analyzer.ts` — 21,
  `tools/runtimeComposition.ts` — 11, `server/src/lib/analysis/arbiter.ts` — 7.
  Это места без конкретного типа, а не число доказанных runtime-ошибок.

## Совместимость не равна перенесённой реализации

`COMPATIBILITY` в `tools/migrationInventory.mts` содержит:

- `server/src/app.js`: проверяет версию Node до первого TS-импорта и запускает `app.ts`.
- `server/src/lib/chat/permission-mcp.js`.
- `server/src/lib/executors/work-mcp.js`.
- `server/src/lib/executors/_direct-ssh-policy-hook.js`.
- `server/src/workers/grigdesk-update-worker.js`.
- `tests/server/grigdesk-release.test.js`.
- `web/public/notification-sw.js`.

Четыре серверных файла между launcher приложения и smoke-тестом содержат собственную
JS-реализацию; TS-копий этих реализаций в дереве нет. Текущий сервер по-прежнему
использует их JS-пути. Поэтому их исключение из счётчика не доказывает перенос логики.
Существование старого entrypoint важно для MCP, sandbox, hooks и обновления старой
установки; его удаление требует проверки фактического вызывающего кода.

Описание `notification-sw.js` в списке расходится с деревом: стоит `generated: true`
и назван источник `web/src/sw/`, но JS отслеживается Git, а указанного каталога нет.
Workbox действительно подключает JS через `importScripts`. На дату аудита это
собственный JS-источник с внешним контрактом имени, а не доказанный результат TS-сборки.

`web/src/shared/speech-pcm-worklet.js` также исполняется отдельно: его URL передаётся
AudioWorklet. Переименование исходника и получение исполняемого браузером JS — разные
шаги, которые требуется проверять вместе.

## Ограничения учёта и запуска

- `tests/docs/migration-inventory.test.mts` сравнивает точные списки legacy и Vue,
  но не сравнивает `typecheckDebt`; его собирает настоящий web-компилятор.
- Vue JS-script учитывается лишь в областях `web*`. Нынешние mobile SFC уже TS,
  но такое правило само по себе не защищает mobile от нового JS-script.
- `tools/entrypointGraph.mts` в `SCANNED_DIRS` отбирает только `.js` и `.ts`.
  MJS/MTS вне явного `ENTRYPOINTS` не покрываются этим отбором.
- `web/tsconfig.scripts.json` включает `scripts/**/*.ts` и `scripts/**/*.mjs`:
  новые `.mts` и Vite config требуют явного включения. В `server/tsconfig.json`
  source-glob — `src/**/*.ts`; будущий `.mts` под `src` также не становится корневым
  файлом проверки автоматически.
- Общие TS-проекты не охватывают весь набор будущих TS-тестов mobile/relay/desktop.
  Сейчас mobile отдельно включает `tests/mobile/helpers/testApp.ts`.
- Package scripts в основном запускают `*.test.js`; отдельные `.mts` в server/web
  перечислены вручную. Переименованный тест может исчезнуть из автоматического запуска,
  даже если ручной запуск успешен.
- `tests/run-all.sh` запускает unit-тесты mobile и desktop, но не вызывает их
  product typecheck. Проверка include инвентаризатором не заменяет запуск компилятора.
- Сборка DeepSeek копирует четыре собственных host-модуля из `tools/*.mjs` под
  фиксированными MJS-именами в runtime. Их перенос связан с output и build-input hash.

Правила изменения снимка описаны отдельно:
[удалённый JS-файл и снимок миграции](../testing/migration-inventory-snapshot.md).
