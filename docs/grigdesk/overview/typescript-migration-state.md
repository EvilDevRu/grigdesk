# Состояние миграции на TypeScript

Остаток JS/Vue проверен 2026-10-21 по рабочему дереву, включая неигнорируемые новые файлы.
Числа ниже — датированный снимок, а не ограничение на дальнейшее развитие проекта.
Актуальные пути перечисляет `node tools/migrationInventory.mts --json`.

## Остаток JavaScript

| Область | JS/MJS | Vue с script без `lang="ts"` |
| --- | ---: | ---: |
| `web/src` | 0 | 0 |
| `server/src` | 7 | — |
| `server/scripts` | 1 | — |
| `web/scripts` | 18 | — |
| `web/vite.config.js` | 1 | — |
| `web/public` | 0 | — |
| `tools` | 5 | — |
| `engine` | 2 | — |
| `deepseek` | 4 | — |
| `tests`, включая helpers и fixtures | 1175 | Отдельные намеренные образцы |
| `shared`, product-код `mobile`, `relay`, `desktop` | 0 | 0 |

Всего 1213 JS/MJS. `remainingBeyondCompatibility()` вычитает шесть поимённых исключений
и возвращает 1207 путей. Продуктовых Vue с JS-script больше нет.
Снимок `tests/fixtures/migration-inventory-baseline.json` обновлён после снятия
переходных исключений web; его списки совпадают с фактическим остатком. Согласованный вход соседних изменений
добавил относительно снимка 32 JS-файла тестов и один web script `check-i18n.mjs`.
Эта входная дельта учитывается отдельно от уменьшения продуктового остатка.

Весь `web/src` перенесён в TypeScript, включая store чата, adapter подтверждений
и крупные Vue `ChatSession` и `PipelineView`. Новые JS-helper сервера:
`server/src/lib/pluginInstall/commandSupervisor.mjs` и `gitBlobPrefix.mjs`.

Зависимости, build output и приватное состояние не являются предметом переноса.
Пять JS-SFC в `tests/web/fixtures/ui` перечислены в `COVERAGE_EXCEPTIONS` и намеренно
проверяют правила компонентов: это не оставшиеся Vue продукта.

## Что означает проверка типов

Общая проверка web, AudioWorklet и отдельная проверка web scripts завершились с кодом 0.
Снимок остатка имеет пустой `typecheckDebt`: он отражает диагностики общего web-компилятора,
а не результат тестов и всех проверок других пакетов. Тесты, их типы и охват новых TS/MTS
проверяются отдельными командами и барьерами инвентаризатора.

25 чистых модулей перенесены в `lowerCamelCase.ts`: 16 shared, четыре helper-а документов
и лимитов, пять локальных сторов;
[границы этой волны](typed-pure-web-modules.md) описаны отдельно.

Все 36 Vue-компонентов этой волны получили TS-script: выбор проекта, иконка исполнителя,
действия топбара, простые оболочки БД/дифа/плагина/терминала, кнопки дифа и избранного,
мини-график, ползунок усилия, панель и страница документов, панели терминала и дифа,
страница чатов, три компонента решений конвейера, App, ToolDock, ToolsGrid, ToolsView,
поповеры таймеров и конвейера, ресурсы исполнителей, AppShell, ToolHost,
ChatList, ChatPermission, ChatQuestion, StepList, BoardView, TaskModal, ChatSession и PipelineView.
[Границы доски и карточки задачи](typed-task-views.md) описаны отдельно.
Для всех продуктовых компонентов сняты
переходные исключения; [входящие данные](typed-web-boundaries.md) проверяются до публикации в UI.

Сторы `providers.ts`, `plugins.ts`, `notifyWatch.ts` и модули речи
`controller.ts`, `provider.ts`, `speechStream.ts` также перенесены; их
[сетевые границы](typed-provider-speech-boundaries.md) сохраняют старые частичные ответы.

Это не означает завершённую миграцию:

- Основной web-проект наследует `allowJs: false`, `checkJs: false` из строгой базы.
  В его `exclude` остался только `shared/node`; все продуктовые Vue включены в проверку.
  Server, проекты тестов и web scripts сохраняют собственные переходные настройки.
- `chatApprovals.ts` экспортирует прямой alias настоящего стора и его типы;
  отдельный собственный `chatApprovals.d.ts` удалён.
- В аудите 2026-10-13 в собственных TS/MTS и TS-script Vue вне tests найдено 77 явных типов `any`
  в 23 файлах. Подсчёт сделан по TypeScript AST, без комментариев и строковых литералов.
  Самые большие группы: `server/src/lib/analysis/analyzer.ts` — 21,
  `deepseek/scripts/runtimeComposition.ts` — 11, `server/src/lib/analysis/arbiter.ts` — 7.
  Это места без конкретного типа, а не число доказанных runtime-ошибок.

## Совместимость не равна перенесённой реализации

`COMPATIBILITY` в `tools/migrationInventory.mts` содержит:

- `server/src/app.js`: проверяет версию Node до первого TS-импорта и запускает `app.ts`.
- `server/src/lib/chat/permission-mcp.js`.
- `server/src/lib/executors/work-mcp.js`.
- `server/src/lib/executors/_direct-ssh-policy-hook.js`.
- `server/src/workers/grigdesk-update-worker.js`.
- `tests/server/grigdesk-release.test.js`.

Четыре серверных файла между launcher приложения и smoke-тестом содержат собственную
JS-реализацию; TS-копий этих реализаций в дереве нет. Текущий сервер по-прежнему
использует их JS-пути. Поэтому их исключение из счётчика не доказывает перенос логики.
Существование старого entrypoint важно для MCP, sandbox, hooks и обновления старой
установки; его удаление требует проверки фактического вызывающего кода.

`web/src/shared/speechPcmWorklet.ts` также исполняется отдельно: Vite выпускает JS asset,
его URL передаётся AudioWorklet. Процессор проверяется и общим web-проектом, и отдельным
проектом без DOM/Node; [граница среды](typed-audio-worklet.md) описана отдельно.

## Ограничения учёта и запуска

- `tests/docs/migration-inventory.test.mts` сравнивает точные списки legacy и Vue,
  но не сравнивает `typecheckDebt`; его собирает настоящий web-компилятор.
- Vue JS-script учитывается лишь в областях `web*`. Нынешние mobile SFC уже TS,
  но такое правило само по себе не защищает mobile от нового JS-script.
- `tools/entrypointGraph.mts` обходит TS/JS, MTS/MJS и CJS/CTS в `SCANNED_DIRS`,
  включая scripts пакета DeepSeek. Installed dependency entry проверяется на наличие,
  внутренние bundled string imports чужих зависимостей не считаются source проекта.
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
