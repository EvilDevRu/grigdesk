# Что лежит в bin/: единая команда, агентские Go-утилиты, сервер, посредник и окно

В исходной копии сервер ставит `<корень>/bin/utilities` и `<корень>/bin` первыми в PATH
агента (`server/src/lib/cliPath.ts`). Тот же порядок использует `grigdesk_add_cli_paths`.
Исполняемые файлы в этих каталогах доступны агенту по имени. Раньше в `bin/` лежали `restart`, `release`, `launch`
и другие служебные скрипты: агент мог перезапустить сервер голым `restart`, а запрет в
профиле был записан по пути `bin/restart` и такой вызов не ловил.

| Файл | Зачем |
| --- | --- |
| `bin/utilities/ctl` | единая команда: окно, сервер, посредник, а также `desktop`, `tracker`, `pipeline`, `voice`, `mobile`, `release` |
| `bin/utilities/tracker` | задачи Б24 по имени для навыков и этапа SHIP фабрики: Go-бинарник из `utilities/tracker/`, вне git, до сборки отсутствует ([сборка](../b24/binary-cli.md)); ссылка `~/.local/bin/tracker` ведёт сюда |
| `bin/utilities/routes` | авторинг маршрутов: Go-бинарник 0755 из `utilities/routes/`, вне git; до сборки отсутствует ([сборка и команды](../pipeline/routes-cli.md)) |
| `bin/utilities/pipeline` | полный пульт конвейера: Go-бинарник из `utilities/pipeline/`, вне git; [команды, exact DTO и исходы](../pipeline/agent-cli.md) |
| `bin/factory` | локальный Go-кандидат из `utilities/factory/`, результат `grigdesk-ctl build factory`, вне git |
| `bin/utilities/voice` | ядро озвучки: Go-бинарник из `utilities/voice/`, вне git, до сборки отсутствует ([ядро озвучки](../media/voice-core.md)) |
| `bin/deepseek` | автономный Harness для DeepSeek и GLM, виден агентам как `deepseek`; отдельные сборка и установка ([поставка](../chat/deepseek-binary.md)) |
| `bin/deepseek.grigdesk-deepseek.json` | приватная SHA-квитанция установщика, обычный файл 0600, не команда |
| `bin/grigdesk-server` | автономный серверный ELF: 0755 после сборки, 0555 после установки; до установки отсутствует ([установщик и откат](../server/server-binary-install.md)) |
| `bin/grigdesk-server.grigdesk-server.json` | private SHA-квитанция серверного установщика, обычный файл 0600 |
| `bin/utilities/maintenance` | нативный helper для подписанной поставки |
| `bin/utilities/relay` | собранный посредник, вне git ([сборка](../mobile/relay-binary.md)) |
| `bin/grigdesk-app` | установленное окно: AppImage из `desktop/release` без расширения в имени, вне git; кладёт `grigdesk-ctl desktop install` ([установка](../web/desktop-window.md)) |
| `bin/grigdesk.png` | иконка ярлыка; копия `web/public/icon-512.png` |

В папке исходников `bin/utilities/ctl build [all|server|web|window|factory|deepseek|apk]` собирает и ставит
компоненты; без цели — сервер, окно, tasks и voice параллельными треками; `deepseek` — отдельная цель поставки исполнителя,
не входящая в `all`. `factory` собирает локальный движок. При `all` сборка фабрики предшествует упаковке сервера.
`apk` отдельно собирает Android-приложение со встроенным вебом
через `tools/mobile build`. Установленный рядом ELF не перехватывает
`dev|build|deps|mobile|release`: эти команды используют исходники и Node разработчика.
Готовый `release.json` и ELF без исходников сохраняют прежний отказ команд разработки.
Сборка не перезапускает процессы; полная сборка сохраняет выбор сервера для следующего запуска окна:
[порядок, кэш и отказы](../server/ctl-build.md).

В checkout `bin/utilities/ctl` появляется после явной сборки Go, как и остальные утилиты:

```bash
tools/build-go-utilities.sh "$PWD/bin/utilities"
```

`utilities/ctl/cmd/ctl` запускает команды из Go, а взаимодействие с окном и инструментами
разработки использует открытые входы в `deploy/` и `tools/`. Готовый файл требуется по
физическому пути. Например, `grigdesk-ctl pipeline` в checkout использует `bin/utilities/pipeline`,
а в регистрации — проверенный `current.server/bin/pipeline`.

На Apple Silicon `grigdesk-ctl build all` и пункт «Сборка → Всё» запускают
`dist build --channel dev`. Нативный рецепт включает приложение macOS, сервер,
maintenance и Go CLI. Он собирается из отдельного снимка исходников. После
успешной приёмки команда выдаёт UUID для `dist check` и `dist install`.
Приватная запись этого UUID закрепляет хеши нативных инструментов проверки.
До публикации результата SIGINT и SIGTERM завершают сборку без verified-записи.
При отмене `dist check` очистка сверяет исходный plist, порт из временной папки
данных и PID со временем старта сервера, подтверждённого командой Start.
При утрате подтверждения команда печатает путь к временной установке и журналам.

`bash tools/server-sea-check` явно собирает прежний SEA-каталог и выполняет его изолированную
приёмку. Обычные `tools/release-check` и `tools/release` этот gate не вызывают:
[разделение путей выпуска](../server/sea-release-gate.md). Сборка и приёмка
[сервера одним ELF](../server/server-binary.md#сборка-и-приёмка) тоже выполняются отдельно.

Человек зовёт их через единую команду: `grigdesk-ctl desktop install`, `grigdesk-ctl mobile build`,
`grigdesk-ctl release patch`. По пути, без единой команды, вызываются `tools/relay build`,
`tools/release-check`, `tools/upgrade-publish-contract` и `deploy/restart.sh`.

Allowlist каталога проверяется в `tests/docs/bin-layout.test.mts`.
Файлы Go могут отсутствовать до сборки. После сборки проверка допускает обычные исполняемые файлы.
Приватные квитанции серверного ELF и DeepSeek имеют права 0600.
Подписанная поставка выделяет собственные пути `server`, `control` и отдельный helper.
