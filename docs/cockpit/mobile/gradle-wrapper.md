# Gradle Wrapper в git

`mobile/android/gradlew`, `gradlew.bat` и `gradle/wrapper/` хранятся в git намеренно: Gradle
рекомендует держать wrapper в системе контроля версий, а Capacitor считает каталог `android/`
исходниками. Сборке не нужен системный Gradle, версия закреплена в репозитории. Сам Gradle в
git не попадает: jar размером около 44 КБ только скачивает дистрибутив по `distributionUrl`
и сверяет `distributionSha256Sum`.

Адрес и SHA256 в `gradle-wrapper.properties` совпадают с `gradleDistribution` из
`mobile/toolchain.lock.json`. `tools/mobile` заранее кладёт проверенный архив в свой
`GRADLE_USER_HOME`, в каталог, имя которого wrapper вычисляет по адресу архива. Другой адрес
в properties обходит этот архив, и wrapper скачивает дистрибутив сам.

Скрипты и jar совпадают с шаблоном Capacitor 8.5.3 байт в байт, jar — также с официальной
суммой Gradle 8.14.3. От шаблона отличаются только properties: архив `-bin` из выпусков
GitHub, SHA256 и тайм-аут сети 60 с.

Jar — единственный бинарник wrapper, и он исполняется при каждой сборке, поэтому его SHA256
закреплён в lock как `gradleWrapperJar.sha256`. `tools/mobile doctor` сверяет файл с этой
суммой; `check`, `build` и `release` начинаются с `doctor`, и подменённый jar останавливает
их первым шагом, до тестов и сборки. При смене версии Gradle новый jar сначала сверяется с
`https://services.gradle.org/distributions/gradle-<версия>-wrapper.jar.sha256`, затем его
сумма переносится в lock.

`npx cap migrate` из Capacitor 8.5.3 перезапускает задачу `wrapper` с `--distribution-type all`
и меняет адрес на архив `-all` с services.gradle.org. Версию wrapper он ищет между `gradle-` и
`-all.zip`, поэтому для `-bin` получает 0.0.0 и всегда считает wrapper устаревшим. После
migrate properties возвращаются к значениям lock.

Сборочные каталоги, `.gradle/`, `local.properties`, ключи `*.jks`/`*.keystore`, копия веба
и Cordova-плагины исключает `mobile/android/.gitignore`; `mobile/node_modules` и
`mobile/dist` — корневой `.gitignore`.
