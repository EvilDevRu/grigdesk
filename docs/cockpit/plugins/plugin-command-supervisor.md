# Владение командами подготовки плагина

`server/src/lib/pluginInstall/runCommand.ts` запускает команды через отдельный
`commandSupervisor.mjs`. Helper находится вне PGID команды. Gated leader создаёт
группу и сообщает PID, PGID и Linux startTime до запуска целевого executable.
`ownership.started` должен устойчиво записать эту identity; только его успешный
результат разрешает ACK и запуск команды.

При abort, timeout или потере IPC владельца supervisor посылает всей собственной
группе SIGTERM, затем через две секунды SIGKILL. Выход непосредственного child также
закрывает оставшихся потомков. Завершение проверяется по `/proc` для всей группы;
открытый pipe внука не считается завершённой командой. Zombie уже не исполняет код
и не держит файловые дескрипторы.

`ownership.finished` вызывается после подтверждённого завершения. Отказ started
не выпускает команду. Отказ finished не выдаётся за успешный результат; адаптер
хранилища сохраняет evidence для последующего восстановления. Если supervisor
исчез без подтверждённого outcome, runner не удаляет durable ownership через finished.

`workerIdentity.ts` проверяет PID + startTime + PGID. Recovery обращается только к
совпавшему supervisor. При живой группе и потерянном либо несовпавшем supervisor
возвращается отказ: сигнал по одному сохранённому PGID запрещён.

`workspaceBudget.ts` измеряет весь заданный сервисом root и свободное место.
Supervisor сериализует обходы, выполняет последний замер перед outcome и снимает
monitoring при завершении. Это мягкий предел; обходы не являются квотой ОС.
Результат содержит самостоятельный `workspaceLimitExceeded`.

Каждый поток хранит хвост до 256 КиБ с явным признаком обрезки. UTF-8 callback
получает полный stderr независимо от хвоста; исключение callback останавливает
свою команду и остаётся за безопасной границей результата.

Поведенческие проверки находятся в `tests/server/plugin-install-run-command.test.js`
и `tests/server/plugin-install-supervisor.test.js`: настоящий child, resistant
grandchild, crash владельца после durable ACK, чужая identity, три независимых
workers и ограничение workspace. Эти проверки относятся к runner; хранилище и
HTTP сервиса установки имеют отдельный контракт и отдельную приёмку.
