# Host hooks DeepSeek и GLM в payload

В каталоге helper-ов зарегистрированы deepseek-instructions-hook и glm-tool-policy-hook
как script entries. Они исполняются сверху; библиотечный импорт не заменяет их работу.
Packaged profiles строят команды через helperCommand: собственный Node из R и собранный
helper. POSIX serializer экранирует каждый аргумент, включая пробелы и одинарные кавычки.
Direct SSH hook использует уже существующий direct-ssh-policy-hook.

Source profiles сохраняют прежнюю сериализацию команд, overlay/hooks bytes и fingerprints.
Это проверяют DeepSeek/GLM golden tests. Компилированная profile fixture извлекает команды
из hooks.json и исполняет их через Bash: instructions раскрывает @fixture.md, GLM пишет
hooks-alive, прямой SSH даёт exit 2. Сам instructions hook раскрывает именно @imports;
основной CLAUDE.md уже читает DSH, поэтому его обычный текст hook не дублирует.

Проверка использует маленький CJS payload и собранные helpers с путями с пробелами и кавычками.
Она подтверждает host hook protocol; полный ELF и настоящие chat turns проверяются отдельно.
