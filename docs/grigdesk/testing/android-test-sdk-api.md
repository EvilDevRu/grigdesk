# API Android при компиляции JVM-тестов

В `:client:testDebugUnitTest` наличие JDK 21 не делает доступным весь API Java 11:
компиляция тестов использует Android SDK. `Files.readString` и `Files.writeString`
не объявлены в используемом SDK; они дают `cannot find symbol` ещё до запуска JUnit.
Используются `Files.readAllBytes` с явным UTF-8 и `Files.write` с байтами UTF-8,
как в AppLockPreferencesTest и существующих ProfileStoreTest.

У `org.json.JSONObject.put` в Android checked `JSONException`. Это касается main-кода
и тестовых реализаций интерфейса без `throws`, например `ShellApi.Gate.snapshot`.
Тестовая Maven-реализация JSON при исполнении не отменяет контракт SDK при компиляции.
Если SPI должен оставаться совместимым с `Supplier`, исключение обрабатывается внутри
реализации и преобразуется в `IllegalStateException`; пример — `AppLock.snapshot`.
Ошибка подготовки или компиляции не считается поведенческим RED.
