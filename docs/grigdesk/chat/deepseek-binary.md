# Самостоятельная поставка DeepSeek

GrigDesk запускает один автономный `bin/deepseek`. Внутри находятся pinned worker Node,
Harness, web/ACP-мосты, native modules, плагин GLM и лицензии. Default и явный
`GRIGDESK_DEEPSEEK_BIN` принимают только совместимый ELF GrigDesk с metadata;
stock `dsh`, поиск в PATH и режимы `installed`/`external` не поддерживаются.

Первый переход требует обновления адаптеров GrigDesk и отдельной установки ELF.
Дальше совместимый бинарник можно заменить без пересборки и перезапуска сервера:
уже начатый ход заканчивается на A, следующий получает B. Проверка перед spawn
не позволяет незаметно применить настройки A к B.

Сборка и установка описаны в [README пакета](../../../deepseek/README.md) и
[контракте установщика](../server/deepseek-binary-install.md). Откат — установка прежнего
ELF тем же установщиком. Обновление GrigDesk проверяет установленный ELF, не собирает
Harness и не заменяет независимо установленный выпуск своей копией.

Распакованные ресурсы находятся в приватном `runtimes/deepseek/packages/<packageId>` папки
данных; home разговора — отдельно, `<runtimeHome>/chats/<sha256(chatKey)>`. Совместимые
A→B→A сохраняют сессию и память модели. Нечитаемый номер журнала вызывает новую сессию
с заметкой, сохраняя ленту; пропавший или повреждённый журнал даёт отказ. Первый переход
переносит прежний DeepSeek home по buildId установленной legacy generation, GLM — по
прежней compatibility. [Переход](deepseek-binary-cutover.md) проверяется отдельно.

GLM допускается по metadata конкретного выпуска и серверной политике режимов/ревизий.
Совместимость с произвольным будущим upstream не обещается. Новый compatibility требует
compiled и живого допуска; Coding Plan закрыт. Offline-проверки используют synthetic keys.

Рабочий хост — Linux x64/glibc. Системный Node для Harness не нужен; shell, работоспособный
bubblewrap и средства управляемых команд по-прежнему нужны. Холодный запуск распаковывает
payload. Тёплый сверяет состав и fingerprints; `--verify` всегда считает полные хэши.
Поколения кэша и резервные ELF пока автоматически не удаляются, поэтому занимают диск.

Изолированная копия server/shared/engine с одним ELF выполняет DeepSeek и GLM с resume и
Factory metadata probe без source package, tools, upstream snapshot и legacy runtime tree.
Поведенческая граница закреплена `tests/server/deepseek-boundary.test.js`.
