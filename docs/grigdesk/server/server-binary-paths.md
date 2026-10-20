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
