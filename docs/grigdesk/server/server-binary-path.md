# PATH одиночного ELF: пользовательские CLI без ссылок

Обозначения I/D/R и границы source/legacy R/payload — в [обзоре сервера](server-binary.md).
Хранение выбранных каталогов и запуск supervisor описаны в [контракте окна](server-binary-desktop.md).

Packaged-запуск строит PATH одной функцией `userCliPath` (`shared/node/userCliPaths.ts`):
I/bin установки, явный `GRIGDESK_CLI_PATH`, сохранённые каталоги descriptor, существующие
`~/.kimi-code/bin`, `~/.local/bin`, `D/state/npm-global/bin`, унаследованный PATH, найденные
версии nvm и последним — собственный Node `R/runtime/node/bin`. Пустые и относительные
элементы отбрасываются, дубли снимаются, поиск в cwd задачи невозможен.

`discoverUserCliDirectories` читает nvm одним уровнем `<NVM_DIR или HOME/.nvm>/versions/node`:
только имена `vN.N.N`, numeric semver по убыванию, только существующие `bin`. Shell rc, alias,
`npm -g` и рекурсивный обход HOME не используются. Отсутствующие умолчания пропускаются;
явный каталог `GRIGDESK_CLI_PATH` сохраняется даже отсутствующим, а EACCES/EPERM на нём —
отказ `cli_path_inaccessible`.

Поиск выполняется один раз при подготовке запуска. `packagedLaunchEnvironment`
(`server/src/lib/seaLaunch.ts`) читает раннюю `.env` с приоритетом env, сверяет D с корнем
установки I, удаляет NODE_OPTIONS и передаёт каталоги в `packagedChildEnvironment`. Окно
передаёт те же каталоги через `buildServerEnv({cli})`. PTY и фабрика наследуют PATH сервера:
`routeLaunchEnv` ставит I/bin первым и не добавляет R/bin. Helper-ы и MCP запускаются явным
путём к Node и от PATH не зависят.

Проверено настоящим shebang `#!/usr/bin/env node` codex только в nvm при GUI PATH
`/usr/bin:/bin`, чужом cwd и без `~/.local/bin/codex`: окно, ручной и unit-запуск, фабрика и
PTY нашли его и выбрали Node nvm; без nvm остаётся собственный Node. Снимок R и `.env` не
менялись. Source, прежний SEA v3 (окно, `launchSeaServer`, unit с PATH установщика) сохраняют
прежний PATH байт в байт.
