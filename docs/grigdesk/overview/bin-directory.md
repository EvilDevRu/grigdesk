# Что лежит в bin/: единая команда, собранные b24, DeepSeek, посредник и окно, иконка

Сервер ставит `<корень>/bin` первым в PATH каждого агента (`server/src/lib/cliPath.ts`), так же
делает `grigdesk_add_cli_paths` в `deploy/lib/runtime-env.sh`. Любой исполняемый файл в `bin/`
становится командой агента по голому имени. Раньше там лежали `restart`, `release`, `launch`
и другие служебные скрипты: агент мог перезапустить сервер голым `restart`, а запрет в
профиле был записан по пути `bin/restart` и такой вызов не ловил.

| Файл | Зачем |
| --- | --- |
| `bin/grigdesk-ctl` | единая команда: окно, сервер, посредник, а также `desktop`, `b24`, `mobile`, `release` |
| `bin/b24` | задачи Б24 по имени для навыков и этапа SHIP фабрики: собранный ELF Node SEA из `b24/`, вне git, до сборки отсутствует ([сборка](../b24/binary-cli.md)); ссылка `~/.local/bin/b24` ведёт сюда |
| `bin/deepseek` | автономный Harness для DeepSeek и GLM, виден агентам как `deepseek`; отдельные сборка и установка ([поставка](../chat/deepseek-binary.md)) |
| `bin/deepseek.grigdesk-deepseek.json` | приватная SHA-квитанция установщика, обычный файл 0600, не команда |
| `bin/grigdesk-relay` | собранный посредник, вне git ([сборка](../mobile/relay-binary.md)) |
| `bin/grigdesk-app` | установленное окно: AppImage из `desktop/release` без расширения в имени, вне git; кладёт `grigdesk-ctl desktop install` ([установка](../web/desktop-window.md)) |
| `bin/grigdesk.png` | иконка ярлыка; копия `web/public/icon-512.png` |

Остальное разложено по назначению, а в `cli/` лежит только TypeScript единой команды:

- `deploy/` — установка и запуск на машине: `install.sh` (сервер и служба), `desktop.sh` (окно,
  за ним стоит `grigdesk-ctl desktop`), `shortcut.sh` (ярлык; его действие `open` — щелчок по ярлыку
  до установки окна), `restart.sh` (перезапуск сервера в ручном режиме, его же зовут кнопка
  «Перезапустить» и обновление), юнит `grigdesk-server.service`;
- `deploy/lib/` — общие bash-функции: `runtime-env.sh` (Node, PATH и порт для `bin/grigdesk-ctl`
  и скриптов), `desktop-app.sh` (пути окна) и куски установщика `install-choices.sh`,
  `media-runtime.sh`, `cli-link.sh`, `b24-cli.sh` (зависимости сборки, сборка и ссылка `b24`), `deepseek-cli.sh` (явная установка отдельного DeepSeek ELF);
- `b24/` — TypeScript-исходник команды `b24` и её сборщик (`npm --prefix b24 run build`);
- `tools/` — инструменты разработчика: `release` и `release-check` (выпуск GrigDesk), `mobile`
  (сборка APK), `relay` (сборка посредника), `upgrade-publish-contract` (переход старых установок).

Серверный release gate `bash tools/server-sea-check` собирает SEA в отдельный каталог
и выполняет его изолированную приёмку; вызывается также общими release-проверками.

Человек зовёт их через единую команду: `grigdesk-ctl desktop install`, `grigdesk-ctl mobile build`,
`grigdesk-ctl release patch`. По пути, без единой команды, вызываются `tools/relay build`,
`tools/release-check`, `tools/upgrade-publish-contract` и `deploy/restart.sh`.

Все исполняемые файлы копии лежат в `bin/`, как в готовом архиве выпуска. Состав закрепляет
`tests/docs/bin-layout.test.mts`: лишний файл в `bin/` (включая брошенную временную копию окна),
публичная или исполняемая квитанция DeepSeek, не TypeScript в `cli/`, расхождение иконки или пропавший бит исполнения у скрипта, которому
`bin/grigdesk-ctl` передаёт команду, валят тест. `bin/b24` и `bin/grigdesk-app` до сборки или
установки могут отсутствовать, а после допускаются только как ELF с правами 0755;
`bin/deepseek` допускает 0755 после сборки или 0555 после установки, до неё отсутствует.
Постоянная квитанция, lock и staging установщика исключены из Git; оставленный staging
в `bin/` всё равно отклоняется проверкой раскладки. Управляемую поставку собирают в отдельный
release-каталог и затем устанавливают; установщик сохраняет старый ELF для отката.
`bin/grigdesk-ctl b24` обязан запускать `bin/b24`, а без него — `b24/src/main.ts`.

Неизменённый legacy worker обновления без systemd перезапускает сервер через `bin/restart`.
После переезда такая установка перезапускается руками:
[переход старых установок](../server/deepseek-release-transition.md).
