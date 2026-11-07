# Обновление GrigDesk с независимым DeepSeek

Marker `server/deepseek-runtime-contract.json` объявляет `format: 1`,
`publishContract: 2`, `mode: binary`. Worker обновления GrigDesk публикует только web и
server dependencies. Он не синхронизирует исходники Harness, не собирает generation,
не переключает `current` и не меняет ELF, его cache или homes чатов.

До установки зависимостей worker проверяет установленный ELF по требованиям целевого
`server/deepseek-host-contract.json`: metadata, bridges, GLM API admission и полный
`--verify` с одноразовым home/cache без ключей. Source staging не содержит установленного
бинарника. Поэтому target smoke получает его абсолютный путь через
`GRIGDESK_RELEASE_BINARY_PATH` и `GRIGDESK_DEEPSEEK_BIN` явно.

После долгой сборки worker повторно проверяет совместимость и SHA перед переключением
checkout. Отсутствующий, изменившийся или несовместимый ELF оставляет прежние checkout и web;
ошибка называет команду `install:binary`. Резервирование и откат ELF принадлежат
[отдельному установщику](deepseek-binary-install.md), а не updater GrigDesk.
Новый сервер подтверждает update только после проверки совместимости установленного ELF.
Embedded buildId больше не является условием readiness.

Переход одноступенчатый. Исторический worker contract 1 отвергает contract 2 до применения
checkout; bridge оставлен следующей поставке. Старые инструменты публикации generation
и stock dsh install сняты. Поиск `dsh` в PATH отсутствует, override также требует metadata
совместимого бинарника.

`bin/grigdesk-ctl deps/run/dev` проверяют независимый DeepSeek без сборки Harness.
Недоступный optional исполнитель не препятствует запуску самого GrigDesk. Прежний
`deepseek:prepare` оставлен как проверка наличия ELF для старого deploy entrypoint;
при отсутствии выводится команда отдельной установки. Установка и ручной перезапуск
выполняются владельцем.

Проверки: `deepseek-binary-update.test.js`, `grigdesk-release.test.js`,
`providers-native-settings-route.test.js`, CLI entry и пять engine DeepSeek сценариев.
