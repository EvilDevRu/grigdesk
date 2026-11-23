# Пробная оболочка 3a (ранние ворота G-ANDROID-2)

Временная инфраструктура пробы 3a плана `grigdesk-additional-platforms-tdd.md` (ред. 9).
Продуктовый код выпуска не меняется. Оболочка переиспользует `:client`
(`mobile/android/client`) без форка: probe-вариант добавляется Gradle init-скриптом,
`applicationIdSuffix ".probe"` даёт `local.grigdesk.mobile.probe`.

## Состав

- `probe.init.gradle` — init-скрипт: buildType `probe` у `:client`
  (`applicationIdSuffix ".probe"`, `useLegacyPackaging=true` для извлечения PIE
  в nativeLibraryDir), probe sourceSet (java/manifest/jniLibs/assets этого каталога).
- `src/LocalServerService.java` — прототип foreground-сервиса: запускает
  `libnode.so` с сервером из `assets/runtime.zip`, задаёт приватный
  `GRIGDESK_HOME` и передаёт серверу путь к `libfactory.so`.
  Поставляемые Bash, Git, flock, nohup и timeout доступны по обычным именам
  через приватный `native-tools` в PATH. При наличии архива stdlib сервис
  раскрывает Python для ABI устройства и передаёт его каталог через `PYTHONHOME`.
- `src/ProbeLauncherActivity.java` — открывает общий WebView и при появлении окна
  запускает локальный сервис. На первом открытии выбирается «Это устройство».
  Нативная заставка держится до подключения, входа и кадра рабочей области.
  При возврате из фона с потерянной локальной связью она ждёт нового готового кадра.
  Отказ или срок в 120 секунд открывают обычное окно. Нативная труба дожидается
  ключа окна и автоматически получает локальную сессию.
- `src/ProbeSplashView.java` — отображает встроенные `desktop/assets/splash` в
  компактном окне 3:2. Gradle копирует HTML, CSS, фон и фирменную надпись в APK.
- `AndroidManifest.xml` — probe-overlay: объявление сервиса с
  `foregroundServiceType="dataSync"`, разрешение FOREGROUND_SERVICE.
- `build-server-bundle.sh` и `build-server-bundle.mts` — собирают
  `server-bundle.cjs` и его зависимости в `assets/runtime.zip`. SEA проверяется отдельно.
- `device-fixture.mjs` — автономная loopback-фикстура OpenAI-compatible API
  (образец `tests/helpers/qwenNativeFixture.mjs`, без импортов репозитория):
  синтетический ключ, уникальная метка `probe-3a-<runId>`, журнал запросов.
- `probe-profile/` — синтетический профиль движка для задачи фабрики с настоящим
  Qwen CLI, направленным в фикстуру (контракт — `docs/engine/PROFILE-CONTRACT.md`).

## Подготовка jniLibs (после проб 2–3)

~~~bash
P=~/.grigdesk/artifacts/additional-platforms
# ANDROID_NDK_HOME указывает на NDK, хост сборки — Linux x64.
ndk="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
for abi in arm64-v8a x86_64; do
  if [ "$abi" = arm64-v8a ]; then
    target=aarch64-linux-android
    arch=arm64
  else
    target=x86_64-linux-android
    arch=amd64
  fi
  libs="tools/android/probe-apk/jniLibs/$abi"
  mkdir -p "$libs"
  cp "$P/probe2-bionic/out/$abi/libnode.so" "$libs/"
  cp "$ndk/sysroot/usr/lib/$target/libc++_shared.so" "$libs/"
  for tool in bash flock timeout nohup git python3; do
    cp "$P/probe3-userland/out/$abi/lib$tool.so" "$libs/"
  done
  GOOS=android GOARCH="$arch" CGO_ENABLED=1 CC="$ndk/bin/${target}30-clang" \
    go build -buildmode=pie -trimpath -buildvcs=false \
    -ldflags=-extldflags=-Wl,-z,max-page-size=16384 -o "$libs/libfactory.so" ./utilities/factory/cmd/factory
done
GRIGDESK_ANDROID_USERLAND_BUILD="$P/probe3-userland/build" \
  bash tools/android/probe-apk/build-server-bundle.sh
~~~

На физическом ARM64 уже проверены старт сервера из меню и прохождение
командного маршрута Go-фабрики до ворот с продолжением
той же попытки в sandbox приложения. Git из нового APK также создаёт связанный
worktree на устройстве. Bionic Python с полной stdlib прошёл `forkpty` в процессе
приложения. Профиль Qwen и весь комплект на x86_64 требуют отдельного прогона.

## Поставка DeepSeek в probe APK

Автономный ELF DeepSeek Harness (android/arm64) кладётся в
`jniLibs/arm64-v8a/libdeepseek.so`. Передайте сборщику каталог готового кандидата:

~~~bash
GRIGDESK_ANDROID_DEEPSEEK_SUPPLY="/путь/к/кандидату" \
  bash tools/android/probe-apk/build-server-bundle.sh
~~~

`LocalServerService` указывает его серверу через `GRIGDESK_DEEPSEEK_BIN`.
NativeLibraryDir — единственное рабочее место: на Android 10+ домен
приложения получает EACCES на exec из собственного каталога данных
(проверено на планшете: карточки дают `deepseek_binary_not_executable`),
а библиотеки установщик распаковывает исполнимыми. `probe.init.gradle`
отключает strip для этого файла: payload SEA живёт в секциях ELF.
Целостность проверяется сравнением SHA-256 ELF в APK с кандидатом.

Поставка включает `node-pty` и `koffi` для Bionic и `sharp-wasm32` с полным набором
зависимостей. Для `sharp-wasm32` 0.35.3 нужны `@emnapi/runtime` 1.11.3 и `tslib` 2.8.1
из lock-файла Harness. Worker использует упаковочный `libnode.so` из nativeLibraryDir.
До пересчёта identity ARM64-поколения примените `patch-harness-journal.mjs` к его
абсолютному пути. Он переводит атомарную публикацию журналов на Bionic `renameat2`
с `RENAME_NOREPLACE`. Синхронизация файла и каталога остаётся частью контракта Harness.

На Android 16 ARM64 прошли `--runtime-info --json` и холодный `--verify`.
Для проверки полного дерева плагинов запустите чтение обеих карточек через
`GET /api/providers?refresh=1` и дождитесь непустых списков моделей. Готовый ELF
в карточке подтверждает установку. Чтобы открыть каталоги, задайте `DEEPSEEK_API_KEY`,
допущенный `GRIGDESK_GLM_API_MODE` и ключ этого режима. Каталог не отправляет `session/prompt`.

После установки исправленной поставки на физический Android 16 ARM64 первый запрос
к серверу вернул 4 модели DeepSeek и 7 моделей GLM (`api`) за 34 с. Повторное чтение
получило те же списки. Проверка каталога прошла без модельного запроса.

## Сборка probe APK на машине с Android SDK

Для ARM64-кандидата с установкой речи пересоберите `assets/runtime.zip` из текущих
исходников и соберите `libffmpeg.so`, `libffprobe.so` и `libgrigdesk_whisper.so`
скриптом `build-speech.sh` с Android NDK, исходниками whisper.cpp и FFmpeg.
Проверьте наличие всех трёх библиотек в `lib/arm64-v8a/` готового APK и файлов
`android_whisper.py`, `android-models.json` и `roots.pem` в `assets/runtime.zip`.
Холодная установка через настройки должна перейти от подготовки окружения к модели GGML.

~~~bash
cd mobile/android
./gradlew :client:assembleProbe -I ../../tools/android/probe-apk/probe.init.gradle
# APK: client/build/outputs/apk/probe/client-probe.apk
apkanalyzer manifest print client/build/outputs/apk/probe/client-probe.apk | grep extractNativeLibs
# ожидается android:extractNativeLibs="true" и applicationId local.grigdesk.mobile.probe
aapt2 dump badging client/build/outputs/apk/probe/client-probe.apk | head -3
~~~

## DEVICE-сценарий Qwen на физическом ARM64

1. `adb install -r client-probe.apk`; проверить ID/ABI до установки (aapt2 выше).
2. Запустить сервис и фикстуру:
   `adb shell am start -n local.grigdesk.mobile.probe/local.grigdesk.client.ProbeLauncherActivity`
   `adb push device-fixture.mjs /data/local/tmp/` (запуск через libnode.so в runbook ниже).
3. Открыть общий интерфейс, создать/открыть локальный проект во внутреннем
   каталоге проектов (`getFilesDir()/projects`, FS подтверждена пробой 3).
4. В пробном профиле запустить через UI фабрики задачу в этом проекте. Первый
   этап пишет в ledger результат настоящего Qwen CLI с уникальной меткой фикстуры.
   Второй этап ждёт барьера тестового API; убедиться, что CLI уже запущен.
5. `adb shell am force-stop local.grigdesk.mobile.probe` во время второго этапа.
6. Вручную открыть probe APK, увидеть прерванный этап, выполнить resume.
   Сверить один результат первого этапа и завершение оставшегося по ledger.
   Проверить, что версия и данные основного клиента (`local.grigdesk.mobile`) прежние.

Каждый пункт — запись отчёта с доказательством (лог/скриншот). Отрицательный исход
фиксирует конкретную границу (UI-труба, локальный проект, исполнитель, recovery)
и останавливает шаги 17–22 до решения владельца. Проба не заменяет приёмку шага 23.

## Runbook фикстуры и CLI на устройстве

~~~bash
# фикстура (внутренний каталог probe, запуск настоящим Bionic Node):
adb shell run-as local.grigdesk.mobile.probe sh -c '
  NATIVE=$(pm path local.grigdesk.mobile.probe | head -1 | cut -d: -f2 | xargs dirname)/lib/arm64
  "$NATIVE/libnode.so" /data/data/local.grigdesk.mobile.probe/files/device-fixture.mjs --port 47900 --run-id probe-3a-1'
# Qwen CLI в пробном профиле: OPENAI_BASE_URL=http://127.0.0.1:47900/v1,
# синтетический ключ из device-fixture.mjs; бинарь CLI — настоящий, из поставки.
~~~

Статус Qwen-сценария: приёмка ожидается.
