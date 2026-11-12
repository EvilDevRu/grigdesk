# Установка Qwen: проверенный hook микрофонного backend

Штатная npm-установка Qwen проходит общий
[gate проверки installer-хуков](provider-install-hooks-review-gate.md).
Для Linux x64 графа `@qwen-code/qwen-code@0.27.2` обнаружены 14 пакетов и один
пакет с install-хуком: `@qwen-code/audio-capture@0.27.2`.
Без его проверенного профиля prepare возвращает `installer_strategy_unverified`.

## Что проверено и закреплено

`install.js` запускает `node-gyp-build` без дополнительных команд. Сначала проверяется
готовый addon; при отсутствии рабочего prebuild запускается `node-gyp rebuild`.
Ошибка native backend печатает предупреждение, но сам hook заканчивается кодом 0:
это необязательная возможность голосового ввода внешнего CLI, не транспорт чата GrigDesk.
Загрузка addon регистрирует функции; запись микрофона начинается только явным вызовом.

В `npmReviewedHooks.json` закреплены точная lifecycle-команда, registry integrity пакета
и sha256 десяти файлов: `install.js`, `binding.gyp`, три файла `native/` и пять addon
в `prebuilds/`. Рассмотрены N-API-код, macOS permission helper и выбор prebuild/build
в зависимости `node-gyp-build@4.8.4`. Заголовок `miniaudio.h` побайтно совпадает с
[upstream 0.11.22](https://github.com/mackron/miniaudio/blob/0.11.22/miniaudio.h).

`binding.gyp` содержит исходники и системные библиотеки, без build actions или загрузок.
На Linux используются `dl`, `pthread`, `m`; miniaudio по умолчанию загружает аудиобиблиотеки
динамически. Для сборки нужны Python 3, make, C++ toolchain и заголовки выбранного Node.
macOS и Windows имеют отдельные системные библиотеки в том же проверенном `binding.gyp`;
локальная проверка исполнения и сборки проведена на Linux x64.

## Offline и старт

`npmStrategy.prepareHeaders` готовит локальные заголовки выбранного Node для любого
проверенного пакета с `binding.gyp`, включая fallback Qwen после prebuild. Ограничение
только именем `node-pty` оставляло бы `node-gyp` возможность загружать их при start:
сам `node-gyp` не соблюдает npm `--offline`. При отсутствии подходящих локальных
заголовков prepare возвращает `node_headers_unavailable` до подтверждения операции.
Заголовки входят в snapshot подготовки и передаются как `npm_config_nodedir`.

Prepare скачивает пакет с `--ignore-scripts`, проверяет профиль и фиксирует полный граф
с integrity. Перед start повторяются snapshot, toolchain и offline-проверка графа.
Сама установка выполняется штатным npm offline с включёнными lifecycle scripts;
пользовательская политика npm не переписывается. Проверка scripts не отключается.

Проверены реальные install и reinstall 0.27.2 через эти функции, с отключённой сетью
на revalidate/start: обычный prebuild и принудительная сборка из исходников.
Оба addon загружены без запуска записи, версия CLI подтверждена. Изменение hook,
`binding.gyp`, исходника или prebuild по-прежнему отклоняется gate.
Это проверка установщика в одноразовом prefix; браузерная приёмка карточки
и оплаченный smoke остаются отдельными обязательными проверками.
