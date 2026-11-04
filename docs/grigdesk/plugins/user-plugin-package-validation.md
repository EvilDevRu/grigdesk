# Проверка пакета до npm и digest результата

Installer проверяет lstat корня, предков и всего дерева до чтения manifest и npm JSON.
Ссылки и спецфайлы, в том числе FIFO, отвергаются без чтения цели. Только реальная
корневая .git с допустимой clone-конфигурацией исключается из payload и лимитов.
Дерево ограничено 5000 файлами и 50 МиБ, plugin.json — 64 КиБ, npm JSON — 2 МиБ.

Manifest проверяется общим decoder scanner/installer по [контракту v1](manifest-v1.md).
Установка требует стабильную version выбранного тега; api=1 и новая структура обязательны.
Description непустой, icon и gallery проходят проверку растров и лимитов.
Объявленные server и web ресурсы — собственные обычные файлы без ссылок, скрытых
компонентов и node_modules. Неверный пакет не импортируется; scanner сохраняет
карточку с причиной, installer отказывает до npm.

Npm-папки требуют package.json и package-lock.json v2/v3. Root declarations всех
категорий и весь lock graph, включая dev/optional, допускают registry dependencies
с integrity. Workspaces, Git/file/link/URL dependencies, project .npmrc, shrinkwrap,
готовые node_modules, Git filters и LFS pointers отвергаются до npm.

Snapshot до npm фиксирует всё исходное дерево. После npm разрешены только относительные
ссылки внутри известных node_modules с конечной целью внутри пакета; абсолютные,
внешние цепочки и ссылки из объявленных ресурсов отвергаются. Изменение исходных файлов не проходит
повторную проверку. SHA-256 payload включает стабильный порядок путей, тип, executable
mode, потоковое содержимое и текст links. Generated зависимости входят в digest,
корневая .git не входит; размер каталогов не хешируется.

Проверено сценариями V1–V20 в plugin-install-validate/payload и регрессиями страниц,
навигации и placements. Эти проверки ещё не означают готовность публикации пакета
или installer HTTP: их runtime и транзакционный допуск реализуются отдельно.
