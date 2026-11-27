# Gradle Wrapper в git

`mobile/android/gradlew`, `gradlew.bat` и `gradle/wrapper/` хранятся в git намеренно: Gradle
рекомендует держать wrapper в системе контроля версий. Сборке не нужен системный Gradle, версия закреплена в репозитории. Сам Gradle в
git не попадает: jar размером около 44 КБ только скачивает дистрибутив по `distributionUrl`
и сверяет `distributionSha256Sum`.

Адрес и SHA256 в `gradle-wrapper.properties` совпадают с `gradleDistribution` из
`mobile/toolchain.lock.json`. `tools/mobile` заранее кладёт проверенный архив в свой
`GRADLE_USER_HOME`, в каталог, имя которого wrapper вычисляет по адресу архива. Другой адрес
в properties обходит этот архив, и wrapper скачивает дистрибутив сам.

Jar — единственный бинарник wrapper, и он исполняется при каждой сборке, поэтому его SHA256
закреплён в lock как `gradleWrapperJar.sha256`. `tools/mobile doctor` сверяет файл с этой
суммой; `check`, `build` и `release` начинаются с `doctor`, и подменённый jar останавливает
их первым шагом, до тестов и сборки. При смене версии Gradle новый jar сначала сверяется с
`https://services.gradle.org/distributions/gradle-<версия>-wrapper.jar.sha256`, затем его
сумма переносится в lock.

Сборочные каталоги, `.gradle/`, `local.properties` и ключи `*.jks` / `*.keystore`
исключены через `mobile/android/.gitignore`.
