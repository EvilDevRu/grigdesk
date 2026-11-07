# Очистка private homes GigaCode после падения

Чат и Factory используют общий runtime root. Каждый новый `turn-*` получает файл
`owner` с PID процесса Node и его `starttime` — полем 22 `/proc/<pid>/stat`.
Owner создаётся с правами 0600 до копирования OAuth cache и монтируется readonly.
Время старта отличает владельца от нового процесса с повторно использованным PID.

Перед `mkdtemp` проверяются только обычные каталоги `turn-*`. Каталог удаляется,
если PID отсутствует либо его текущее время старта отличается от owner.
Живые home чата и Factory сохраняются независимо от возраста. Проверка `/proc`
использует общий Linux identity reader из `server/src/lib/packageInstall/workerIdentity.ts`;
ошибка доступа не считается смертью. Прежнего пути `pluginInstall/workerIdentity.ts`
нет: импорт из него останавливает сборку CJS payload серверного ELF ещё на `prepare`.

Ссылки, повреждённые owner и каталоги без owner автоматически не удаляются.
Параллельное создание может находиться между `mkdtemp` и записью owner, но токен
появляется только после успешной записи owner. Старые home без owner требуют
отдельной ручной проверки; надёжно установить их владельца по возрасту нельзя.
При штатном завершении собственный home по-прежнему удаляется сразу.

Проверка очистки, сохранения живых home и readonly owner —
`tests/server/gigacode-profile.test.js`; контракт CJS payload —
`tests/server/server-binary-bundle.test.js`. Замыкание полного графа приложения
проверяется вызовом `bundlePayloadServer` без подмены `app.ts`.
