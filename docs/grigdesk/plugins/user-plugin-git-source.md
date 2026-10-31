# Проверка Git-источника пользовательского плагина

`server/src/lib/packageInstall/gitSource.ts` реализует `PluginSource`. Listing возвращает
стабильные теги `vX.Y.Z`, выбирает peeled commit аннотированного тега и сортирует SemVer.
Нормализация допускает HTTPS без userinfo, SSH без пароля, короткий SSH адрес и абсолютный
file URL без host. Управляющие символы, query/fragment и SSH option injection отвергаются
до команды.

Fetch выполняет полный clone без checkout, local hardlinks и template. Точный
`refs/tags/<tag>^{commit}` сверяется с выбранным SHA. До materialization `ls-tree -rz -l`
проверяет mode120000/mode160000, число и bytes blobs. Filters, working-tree-encoding,
LFS pointers, вложенная `.git`, `.gitmodules`, `.npmrc`, shrinkwrap и принесённый
node_modules отвергаются. Для больших blobs отдельный trusted helper читает prefix и
дренирует оставшийся поток внутри той же owned process group.

Каждая Git команда использует закрытую среду и policy flags. HTTPS получает отдельный
config0600 только с credential.helper из доверенных host settings; includes, url rewrites
и исполняемые настройки не копируются. SSH использует BatchMode, ограниченный connect
и включённую проверку host key. Временный config удаляется после завершения команды.
Политика конфигурации опирается на [документацию Git](https://git-scm.com/docs/git-config/2.34.0)
и [правила выбора global config](https://git-scm.com/docs/git#Documentation/git.txt-codeGITCONFIGGLOBALcode).

`gitMetadata.ts` до Git проверяет реальные предки, реальную корневую `.git`, известную
конфигурацию и её digest. Worktree config, commondir, alternates, grafts и внешние
attributes не допускаются. Tracked, новые и ignored файлы вне известных generated
npmDirs считаются local changes. Полный payload dependencies проверяет отдельный
снимок при применении, а не каждый дешёвый inspection.

История и diff используют NUL поля и сохраняют UTF-8, TAB и LF. Список ограничен
50 коммитами и 200 файлами с явным truncated. Обрезанный structured stdout вызывает
command_output_limit. Ошибка команды не становится пустым diff.

Проверки `plugin-install-git-source.test.js` и `plugin-install-git-policy.test.js` работают
на собственных локальных repositories. Они используют реальные опасные handlers с
положительными marker controls, конфликт branch/tag, symlink/gitlink, history budget,
подменённую metadata и обрезанный вывод. Это контракт стратегии источника; интерфейс
установки, durable transaction и runtime lifecycle имеют отдельную приёмку.
