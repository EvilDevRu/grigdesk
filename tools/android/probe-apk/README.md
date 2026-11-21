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
  `libnode.so` с серверным bundle из assets, `GRIGDESK_HOME` во внутреннем
  приватном каталоге, перезапуск после kill по политике FGS.
- `AndroidManifest.xml` — probe-overlay: объявление сервиса с
  `foregroundServiceType="dataSync"`, разрешение FOREGROUND_SERVICE.
- `build-server-bundle.sh` — esbuild-bundle сервера (`server/src/app.ts`) в
  `assets/server-bundle.js` пробной сборки (JS bundle по Q2; SEA — отдельная проба).
- `device-fixture.mjs` — автономная loopback-фикстура OpenAI-compatible API
  (образец `tests/helpers/qwenNativeFixture.mjs`, без импортов репозитория):
  синтетический ключ, уникальная метка `probe-3a-<runId>`, журнал запросов.
- `probe-profile/` — синтетический профиль движка для задачи фабрики с настоящим
  Qwen CLI, направленным в фикстуру (контракт — `docs/engine/PROFILE-CONTRACT.md`).

## Подготовка jniLibs (после проб 2–3)

~~~bash
P=~/.grigdesk/artifacts/additional-platforms
mkdir -p tools/android/probe-apk/jniLibs/arm64-v8a
cp "$P/probe2-bionic/out/arm64-v8a/libnode.so" tools/android/probe-apk/jniLibs/arm64-v8a/
for u in bash flock timeout nohup git python3; do
  cp "$P/probe3-userland/out/arm64-v8a/lib$u.so" tools/android/probe-apk/jniLibs/arm64-v8a/
done
bash tools/android/probe-apk/build-server-bundle.sh
~~~

Python3 требует stdlib `lib/python3.12` рядом с бинарём (упаковать в assets
и распаковать во внутренний каталог при первом старте; прототип сервиса это делает).

## Сборка probe APK (машина с Android SDK; владелец)

~~~bash
cd mobile/android
./gradlew :client:assembleProbe -I ../../tools/android/probe-apk/probe.init.gradle
# APK: client/build/outputs/apk/probe/client-probe.apk
apkanalyzer manifest print client/build/outputs/apk/probe/client-probe.apk | grep extractNativeLibs
# ожидается android:extractNativeLibs="true" и applicationId local.grigdesk.mobile.probe
aapt2 dump badging client/build/outputs/apk/probe/client-probe.apk | head -3
~~~

## DEVICE-сценарий (владелец, физическое ARM64; DEVICE PENDING)

1. `adb install -r client-probe.apk`; проверить ID/ABI до установки (aapt2 выше).
2. Запустить сервис и фикстуру:
   `adb shell am start-foreground-service -n local.grigdesk.mobile.probe/local.grigdesk.client.LocalServerService`
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

Статус: **DEVICE PENDING** — физического ARM64 устройства у исполнителя нет;
APK собирается после готовности libnode.so/userland (пробы 2–3) на машине с SDK.