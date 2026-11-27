# Снимок исходников DeepSeek


`deepseek/vendor/deepseek-harness/` закрепляет выбранный набор DeepSeek Harness
`0.2.3-alpha.2`, commit `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`.
Опись включает 244 выбранных корня и 5240 файлов. `deepseek/ports/0.2.3-alpha.2/`
хранит исходную selection и патчи этого выпуска. Штатная сборка читает
опубликованный manifest и его копии патчей. Чаты и конвейеры используют
автономный ELF с проверенным поколением. [Состав runtime](deepseek-vendored-composition.md)

## Что лежит в Git, а что в кэше

В Git хранятся только `upstream.lock.json`, `patches/`, `LICENSE` и `THIRD_PARTY_NOTICES.md`.
Сами исходники `upstream/` — игнорируемый кэш, который перед сборкой пакета явно
подготавливает `materializeDeepSeekSnapshot`: [команды чистого checkout](../../../deepseek/README.md).
Функция принимает проверяемый `seedDir` или локальный Git `sourceDir` с нужным commit;
иначе получает точный SHA из закреплённого repository. Update worker исходники не готовит.
Каждый извлечённый файл сверяется с Git blob ID и SHA-256 из manifest; любое расхождение
отвергает commit, прежний кэш не трогается. Испорченный или неполный кэш заменяется целиком
проверенной копией. Без подготовленного кэша сборка отказывает с командой подготовки.

`upstream.lock.json` содержит repository, полный SHA, версию, selection (корни с причинами
включения), по одной строке на файл (путь, режим, Git blob ID, SHA-256), identity dependency
lock, хеши патчей и обязательные gates. Причина включения хранится у корня, а не повторяется
в записи файла. Оригинальные LICENSE и THIRD_PARTY_NOTICES.md лежат рядом с manifest;
notices upstream охватывают его полный проект, а не доказывают состав сокращённого runtime.
Входы сборки считаются по manifest без самих исходников, поэтому проверка готового
поколения не требует ни кэша, ни сети.

## Подготовка и публикация обновления

`deepseek/scripts/syncDeepSeekHarness.mts` требует явный полный `--commit`. Прежний снимок сначала
подготавливается по своему manifest (из `--source-dir`, если там есть его commit, иначе по
сети). Подготовка создаёт staging и JSON recipe, показывает added/changed/deleted, включая
изменения executable mode. `--source-dir` читает Git objects локального репозитория без
сети; без него указанный commit берётся из закреплённого upstream. Незакоммиченные файлы
source-dir не используются. Для первичного импорта выбор корней передаётся через
`--selection`, иначе selection берётся из manifest.

Публикация — отдельная команда с тем же SHA:

```bash
node deepseek/scripts/syncDeepSeekHarness.mts --commit "$upstream_sha" \
  --candidate "$candidate_file"

node deepseek/scripts/syncDeepSeekHarness.mts --commit "$upstream_sha" \
  --publish "$candidate_file"
```

Инструмент проверяет старые хеши до подготовки и повторно перед публикацией, exact
набор файлов, лицензии, dependency lock и патчи. Traversal, symlinks, submodules,
ручные изменения и незарегистрированные файлы запрещены. Извлечённые `git archive`
байты сверяются с Git blob: `export-subst` не может незаметно изменить исходник.
Пустой каталог патчей может отсутствовать в чистом checkout; наличие записей патчей
в manifest требует всех соответствующих файлов.

Исходный `upstream/` не является рабочей папкой для native/ABI-экспериментов.
В частности, `native/system/test/link-platform.mjs` создаёт в нём `node_modules`,
который нарушает manifest. Запускайте такие проверки только в отдельной копии;
[разбор и регрессии](../testing/deepseek-vendor-node-modules.md).

Патчи проверяются и применяются только в отдельной копии. Публикация использует
writer lock и replacement directory; конфликт не меняет прежний snapshot. При
публикации обязателен compiled candidate gate, который запоминается в manifest;
неизвестный или потерянный обязательный gate запрещает публикацию.

Эти операции не делают Git commit/push и не переключают runtime/current. В commit
обновления попадают только manifest, патчи и лицензии. Зависимости подготавливаются
заранее; публикация запускает offline build и compiled проверки. Поведенческие
проверки — `tests/server/deepseek-vendor-sync.test.js`.
