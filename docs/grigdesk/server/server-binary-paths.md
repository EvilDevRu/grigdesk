# Ресурсы payload и физическая установка

Контекст payload задаёт физические bundleFile и binary до загрузки приложения.
`createRuntimePaths` берёт ресурсный R от server/payload.cjs, Node от
R/runtime/node/bin/node, installationBin от физического внешнего ELF и installationRoot
от его родителя. Относительные пути отвергаются. Cwd и обычный process.execPath
не определяют R или I.

Source и прежний SEA сохраняют installationRoot=R, installationBin=R/bin.
Helper вычисляет R по собственному URL. Новый host-owned GRIGDESK_SERVER_BINARY
передаёт ему I; без этой переменной helper сохраняет прежний контракт SEA.
Окружение не переключает режим сборки на source. Ключ включён в HOST_ENV_SUFFIXES.

Встроенные навыки лежат в R/tools/skills. Оба allowlist ресурсов копируют этот
каталог из исходников, а аудит автономного payload требует
`tools/skills/connect-project/SKILL.md`; другие ресурсы tools вне skills запрещены.
При старте сервер зеркалит навыки в общий пользовательский каталог, который читают
меню и исполнители. Проверка доставки копирует настоящий ресурс обоих allowlist,
устанавливает его в изолированный home и проверяет пункт меню —
[контракт навыка](../chat/connect-project-skill.md).
