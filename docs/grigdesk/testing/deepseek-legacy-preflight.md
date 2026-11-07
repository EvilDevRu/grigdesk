# Автоподготовка окружения миграции DeepSeek

Успешная подготовка автономного ELF не означает готовность legacy fixture общего прогона.
`tests/run-all.sh` сначала вызывает `deepseekBinary.mts --prepare-suite`: этот helper
проверяет бинарный candidate, A/B и admitted варианты с pinned Node 24. Зависимости берутся
из `<node-cache>/runtime-deps-node24`; обычная сборка использует тот же способ подготовки.

После этого `deepseekRuntimeArtifact.mts` отдельно строит прежнюю generation под текущим
Node тестового процесса. Для сценариев первого перехода это обычно Node 22. Когда нет
готовой generation, helper автоматически вызывает `prepareLegacyDeepSeekDependencies()`.
Ручная установка в `deepseek/build/runtime-deps/node_modules` не нужна.

Exact package.json и lock копируются в private staging внутри
`<artifacts>/deepseek-vendoring/legacy-dependencies/`. Ключ готового prefix включает их
SHA256, полную версию Node, native ABI, платформу и архитектуру. `npm ci --include=dev`
исполняется текущим Node, с собственными HOME, журналом и отключённым пользовательским
npmrc. Lifecycle получает тот же Node первым в PATH. Можно переиспользовать npm-cache
подготовленного Node 24, но установленные native-пакеты находятся в отдельном prefix.

Перед публикацией проверяются версии всех прямых пакетов по exact lock и загрузка
TypeScript, esbuild, sharp, koffi и node-pty текущим Node. Marker записывается последним,
затем staging атомарно переименовывается. Builder получает `--runtime-deps-dir` с этим prefix.
Production binary, подготовленный `runtime-deps-node24` и исходный prefix не переписываются.

Standalone-проверка `tests/deepseek/buildInputs.test.mts` получает тот же автоматически
подготовленный prefix и передаёт его копии builder через CLI. Она также работает без
установленных пакетов в исходном `deepseek/build/runtime-deps/`. Общий срок её сценария
учитывает холодную подготовку и две сборки; отдельный срок каждой команды не увеличивается.

При повторном использовании проверяются marker, точные manifests, версии пакетов и загрузка
native-модулей. Незавершённая установка, чужой ABI или повреждённая зависимость автоматически
перестраиваются. Изменённый lock или Node выбирает отдельный кэш. Directory lock допускает
одного установщика, ограничивает ожидание и восстанавливается по PID/starttime после падения.
Generation также собирается под таким lock. Готовая generation по-прежнему проходит полную
проверку payload; явный `GRIGDESK_TEST_DEEPSEEK_ARTIFACT` не запускает автоподготовку.

Legacy generation нужна `deepseek-binary-cutover-sessions.test.js`: тест сначала создаёт
сессию старым runtime, затем проверяет перенос памяти и sessionId в автономную поставку.
Общий прогон считает отказ её подготовки ошибкой до основной части тестов.

Первый запуск при пустом npm-cache может обращаться в сеть. Повторный запуск с готовым
prefix не запускает npm. При отказе подготовка сообщает именно об окружении теста миграции,
версию Node, ABI и путь журнала; следующий запуск повторяет подготовку автоматически.
Проверки чистого/прогретого кэша, конкуренции и восстановления находятся в
`tests/server/deepseek-legacy-dependencies.test.js`.
