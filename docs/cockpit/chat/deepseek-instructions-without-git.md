# DeepSeek: импорты инструкций в папке без Git

`nearestProjectRoot()` ищет вверх каталог с `.git`, при его отсутствии root равен cwd.
Hook `server/scripts/deepseekInstructionsHook.mts` больше не требует `.git`: он вызывает
`expandInstructionImports()` и для обычного каталога. Прежняя проверка `fs.access(.git)`
возвращала пустой контекст до чтения локальных импортов.

Роль hook ограничена точными отдельными строками `@путь` в инструкциях между root и cwd.
Основные AGENTS/CLAUDE читает модуль `agent-instructions` DSH; hook их не дублирует.
Проверки realpath цели, типа, размера, глубины и циклов остаются. Импорт через симлинк
за пределы root запрещён. Повреждённый stdin остаётся fail-open с диагностикой.

`tests/server/deepseek-instructions-hook.test.js` запускает весь hook, включая оболочку,
для Git и без Git. Это проверка дополнения импортов; загрузку основных инструкций
закреплённой версией DSH она не подменяет.
