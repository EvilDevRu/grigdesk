# Что лежит в bin/: единая команда, агентские SEA, сервер, посредник и окно

Сервер ставит `<корень>/bin` первым в PATH каждого агента (`server/src/lib/cliPath.ts`), так же
делает `grigdesk_add_cli_paths` в `deploy/lib/runtime-env.sh`. Любой исполняемый файл в `bin/`
становится командой агента по голому имени. Раньше там лежали `restart`, `release`, `launch`
и другие служебные скрипты: агент мог перезапустить сервер голым `restart`, а запрет в
профиле был записан по пути `bin/restart` и такой вызов не ловил.

| Файл | Зачем |
| --- | --- |
| `bin/grigdesk-ctl` | единая команда: окно, сервер, посредник, а также `desktop`, `tracker`, `pipeline`, `voice`, `mobile`, `release` |
| `bin/tracker` | задачи Б24 по имени для навыков и этапа SHIP фабрики: собранный ELF Node SEA из `tracker/`, вне git, до сборки отсутствует ([сборка](../b24/binary-cli.md)); ссылка `~/.local/bin/tracker` ведёт сюда |
| `bin/routes` | авторинг маршрутов: ELF Node SEA 0755 из routes/, вне git; до сборки отсутствует ([сборка и команды](../pipeline/routes-cli.md)) |
| `bin/pipeline` | полный пульт конвейера: отдельный ELF 0755 из общего пакета tracker/, вне git; [команды, exact DTO и исходы](../pipeline/agent-cli.md) |
| `bin/voice` | ядро озвучки: собранный ELF Node SEA из `voice/`, вне git, до сборки отсутствует ([ядро озвучки](../media/voice-core.md)) |
| `bin/deepseek` | автономный Harness для DeepSeek и GLM, виден агентам как `deepseek`; отдельные сборка и установка ([поставка](../chat/deepseek-binary.md)) |
| `bin/deepseek.grigdesk-deepseek.json` | приватная SHA-квитанция установщика, обычный файл 0600, не команда |
| `bin/grigdesk-server` | автономный серверный ELF: 0755 после сборки, 0555 после установки; до установки отсутствует ([установщик и откат](../server/server-binary-install.md)) |
| `bin/grigdesk-server.grigdesk-server.json` | private SHA-квитанция серверного установщика, обычный файл 0600 |
| `bin/grigdesk-relay` | собранный посредник, вне git ([сборка](../mobile/relay-binary.md)) |
| `bin/grigdesk-app` | установленное окно: AppImage из `desktop/release` без расширения в имени, вне git; кладёт `grigdesk-ctl desktop install` ([установка](../web/desktop-window.md)) |
| `bin/grigdesk.png` | иконка ярлыка; копия `web/public/icon-512.png` |

В папке исходников `bin/grigdesk-ctl build [all|server|web|window|deepseek|apk]` собирает и ставит
компоненты; без цели — сервер, окно, tasks и voice параллельными треками; `deepseek` — отдельная цель поставки исполнителя,
не входящая в `all`. `apk` отдельно собирает Android-приложение со встроенным вебом
через `tools/mobile build`. Установленный рядом ELF не перехватывает
`dev|build|deps|mobile|release`: эти команды используют исходники и Node разработчика.
Готовый `release.json` и ELF без исходников сохраняют прежний отказ команд разработки.
Сборка не перезапускает процессы; полная сборка сохраняет выбор сервера для следующего запуска окна:
[порядок, кэш и отказы](../server/ctl-build.md).

Остальное разложено по назначению, а в `cli/` лежит только TypeScript единой команды:

- `deploy/` — установка и запуск на машине: `install.sh` (сервер и служба), `desktop.sh` (окно,
  за ним стоит `grigdesk-ctl desktop`), `shortcut.sh` (ярлык; его действие `open` — щелчок по ярлыку
  до установки окна), `restart.sh` (перезапуск сервера в ручном режиме, его же зовут кнопка
  «Перезапустить» и обновление), юнит `grigdesk-server.service`;
- `deploy/lib/` — общие bash-функции: `runtime-env.sh` (Node, PATH и порт для `bin/grigdesk-ctl`
  и скриптов), `desktop-app.sh` (пути окна) и куски установщика `install-choices.sh`,
  `media-runtime.sh`, `cli-link.sh`, `agent-cli.sh` (общая установка CLI), `tracker-cli.sh` и `routes-cli.sh` (входы пакетов), `deepseek-cli.sh` (явная установка отдельного DeepSeek ELF);
- `tracker/` — общий пакет CLI `tracker` и `pipeline`: `npm --prefix tracker run build`
  и `build:pipeline`;
- `routes/` — отдельный пакет CLI авторинга маршрутов: `npm --prefix routes run build`
  выпускает `bin/routes`. Общий SEA-протокол находится в `shared/node/cliSeaBuild.ts`;
  в `grigdesk-ctl build all` одна tasks-цепочка последовательно собирает tracker, pipeline и routes;
- `voice/` — TypeScript-исходник команды `voice` и её сборщик (`npm --prefix voice run build`;
  цель «Всё» и релизный bundle собирают его прямо в `bin/voice`);
- `tools/` — инструменты разработчика: `release` и `release-check` (выпуск GrigDesk), `mobile`
  (сборка APK), `relay` (сборка посредника), `upgrade-publish-contract` (переход старых установок).

`bash tools/server-sea-check` явно собирает прежний SEA-каталог и выполняет его изолированную
приёмку. Обычные `tools/release-check` и `tools/release` этот gate не вызывают:
[разделение путей выпуска](../server/sea-release-gate.md). Сборка и приёмка
[сервера одним ELF](../server/server-binary.md#сборка-и-приёмка) тоже выполняются отдельно.

Человек зовёт их через единую команду: `grigdesk-ctl desktop install`, `grigdesk-ctl mobile build`,
`grigdesk-ctl release patch`. По пути, без единой команды, вызываются `tools/relay build`,
`tools/release-check`, `tools/upgrade-publish-contract` и `deploy/restart.sh`.

Все исполняемые файлы копии лежат в `bin/`, как в готовом архиве выпуска. Состав закрепляет
`tests/docs/bin-layout.test.mts`: лишний файл в `bin/` (включая брошенную временную копию окна),
публичная или исполняемая квитанция DeepSeek/сервера, не TypeScript в `cli/`, расхождение иконки или пропавший бит исполнения у скрипта, которому
`bin/grigdesk-ctl` передаёт команду, валят тест. `bin/tracker`, `bin/voice` и `bin/grigdesk-app` в checkout до сборки или
установки могут отсутствовать, а после допускаются только как ELF с правами 0755;
`bin/deepseek` и `bin/grigdesk-server` допускают 0755 после сборки или 0555 после установки,
до неё отсутствуют. Символические ссылки ELF и receipt запрещены; allowlist содержит точные имена.
Постоянная квитанция, lock и staging установщика исключены из Git; оставленный staging
в `bin/` всё равно отклоняется проверкой раскладки. Управляемую поставку собирают в отдельный
release-каталог и затем устанавливают; установщик сохраняет старый ELF для отката.
`bin/grigdesk-ctl tracker` обязан запускать `bin/tracker`, а без него — `tracker/src/main.ts`.
Так же `grigdesk-ctl voice` вызывает `bin/voice`, а в исходниках без него — `voice/src/main.ts`.
В подписанном серверном архиве v2 `bin/voice` имеет readonly права 0555, как остальные файлы поколения.

Неизменённый legacy worker обновления без systemd перезапускает сервер через `bin/restart`.
После переезда такая установка перезапускается руками:
[переход старых установок](../server/deepseek-release-transition.md).

`bin/grigdesk-ctl pipeline` из исходников использует готовый `bin/pipeline`, а без него —
`tracker/src/pipelineMain.ts`. В дереве с выбранным `bin/grigdesk-server` готовый `bin/pipeline`
обязателен: отсутствие даёт код 1 без source-fallback, как в соседней ветке tracker.
В официальной установке maintenance ctl выбирает `current.server/bin/pipeline` через receipt;
другая установка, PATH и исходники запасным входом не становятся.
