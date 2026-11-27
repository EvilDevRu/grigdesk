# Автономный DeepSeek Harness

Пакет собирает нативный исполняемый файл для Linux x64 с glibc или macOS 15+
на Apple Silicon. Внутри launcher Node SEA, закреплённый worker Node,
Harness, web/ACP-мосты GrigDesk, плагин GLM, native resources и лицензии. При запуске рядом
не нужны исходники, npm или установленный Node. Shell, bubblewrap и прочие системные средства инструментов остаются требованиями хоста;
управляемые команды используют доступный backend systemd либо собственную группу процессов.
Нативный прогон macOS выполняется отдельно. Установка ниже описывает Linux.

## Сборка из чистого checkout

Из корня репозитория нужны Node `^22.19.0 || >=24.0.0`, npm, git, tar/xz, C compiler и
системные библиотеки native dependencies. Worker Node 24.22.3 закреплён в
`build/node-runtime.json` для Linux x64 и в отдельных описях
`build/node-runtime-linux-arm64.json` и `build/node-runtime-darwin-arm64.json`.
Сборка generation использует ABI выбранного worker. Версия Node сервера выбирается отдельно.

```bash
npm ci --include=dev --prefix deepseek
npm --prefix deepseek run prepare:runtime
node --input-type=module -e "import { materializeDeepSeekSnapshot } from './deepseek/scripts/deepseekVendorManifest.ts'; await materializeDeepSeekSnapshot('./deepseek/vendor/deepseek-harness');"
npm --prefix deepseek run build -- --out-dir /absolute/release
npm --prefix deepseek run verify -- --binary /absolute/release/deepseek
```

Подготовка snapshot получает точный commit manifest и сверяет каждый файл; повторный вызов
переиспользует исправный кэш. Для offline подготовки функция принимает `sourceDir` с Git
objects нужного commit или `seedDir` с проверяемыми исходниками. Чистому checkout сначала
нужна сеть для Node, npm и upstream. Обычный build не устанавливает dependencies скрыто:
`prepare:runtime` — отдельный явный шаг. Его и build можно направить в один внешний cache
аргументом `--node-cache-dir /absolute/build-cache`. По умолчанию это `deepseek/.cache/`.
Подготовленные worker и зависимости лежат внутри `<цель>-<SHA256 архива>/` в этом кэше.

Для разработки default output — `bin/deepseek`. Для управляемой установки собирайте в
отдельный release-каталог, затем публикуйте через установщик. Параметры `--binary-version`
и `--payload` позволяют переупаковать проверенный payload с его manifest-sidecar;
`--vendor-dir` выбирает проверенный source candidate и несовместим с `--payload`.


Закреплён Harness `0.2.3-alpha.2`. Патч каталога входит в опись снимка и добавляет GLM-5.4
в обычный API и Coding Plan, а GLM-5.3-FlashX и GLM-5.3-FlashX-Legal в обычный API.
Сборка применяет патч автоматически. Перед установкой проверяйте допуск готового бинарника.

## Установка и откат

```bash
npm --prefix deepseek run install:binary -- --binary /absolute/release/deepseek \
  --target "$PWD/bin/deepseek" --host-contract "$PWD/server/deepseek-host-contract.json"
```

Установщик проверяет metadata, полный payload и серверный host/GLM contract до atomic rename.
Существующий target должен принадлежать этому установщику: SHA-квитанция приватна, ELF
публикуется с правами 0555. Резервный ELF сохраняется в каталоге releases папки данных.
Откат — та же команда с прежним ELF. Если новый writer журнала не читается прежним reader,
установщик предупреждает; чат сохраняет ленту и начинает новую runtime session с заметкой.

Последующие совместимые замены ELF не требуют пересборки или перезапуска GrigDesk.
Первый переход на бинарные адаптеры требует обновления сервера. Автоматической загрузки
latest и отдельной команды rollback нет. Допуск нового GLM compatibility требует своей
живой проверки; offline-тесты его не предоставляют.

## Запуск и проверки

`--runtime-info --json` возвращает только metadata. `--verify` всегда пересчитывает полные
хэши и проверяет native загрузку. `--cache-dir` требует абсолютный приватный путь; по умолчанию
кэш располагается в папке данных GrigDesk. Первый рабочий запуск атомарно распаковывает
payload, следующие сверяют состав и kernel fingerprints. Повреждение вызывает полную
проверку и отказ либо восстановление. Старые поколения кэша автоматически не удаляются.

```bash
npm --prefix deepseek run typecheck
npm --prefix deepseek test
npm --prefix deepseek run test:sea
```

Тестовые scripts используют сторож памяти. SEA-набор запускает настоящий ELF, web/ACP,
native modules и остановку. Fixtures используют только одноразовые homes и loopback API.
Build cache тестов с pinned dependencies подготавливается явно; команды отказа указывают
его путь. Production homes, ключи и история в поставку не входят.

Внутри payload лежат LICENSE worker Node, upstream LICENSE/THIRD_PARTY_NOTICES и
`generation/licenses/index.json` с npm/native notices и обязательными supplements.
Источники supplements закреплены в `build/licenses/sources.json`.
Подробности: [сборка](../docs/grigdesk/chat/deepseek-binary-build.md),
[поставка](../docs/grigdesk/chat/deepseek-binary.md),
[установка](../docs/grigdesk/server/deepseek-binary-install.md).
