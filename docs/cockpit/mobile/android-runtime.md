# Локальное окружение Кокпита на Android

Проверено по исходникам проекта и документации платформ 2026-10-13. Запуск сервера
Кокпита и его исполнителей на физическом Android в этой проверке не выполнялся.

## Что уже есть в проекте

Текущий APK содержит интерфейс и подключается к внешнему серверу через посредника:
[архитектура приложения](architecture.md). Он не содержит локальный сервер Кокпита.
Сервер работает непосредственно на хосте; Docker не является обязательной оболочкой
для его запуска: [контракт сервера](../server/host-native-runtime.md).

В [server/package.json](../../../server/package.json) сервер запускается через Node.js,
а [bin/cockpit](../../../bin/cockpit) поддерживает запуск без systemd. Наличие Node.js
на другой платформе само по себе не подтверждает переносимость исполнителей,
их песочниц, инструментов проектов и интеграций с хостом.

## Почему FEX и Wine не дают Docker

FEXCore исполняет инструкции x86/x86-64 и может собираться для Android AArch64.
Это не собственное ядро Linux. [FAQ upstream FEX](https://wiki.fex-emu.com/index.php/FAQ)
не обещает поддержку Android как Linux-окружения, но не описывает возможности всех
сторонних оболочек. DroidDeck поставляет Linux rootfs и адаптированный PRoot и использует
FEX для x86-программ: [проверенные детали упаковки](android-linux-packaging.md).
[Proton](https://github.com/ValveSoftware/Proton) использует Wine для запуска Windows-игр
на Linux. Слои совместимости не предоставляют гипервизор для Docker Desktop.

Docker опирается на функции ядра, включая namespaces и cgroups:
[устройство изоляции Docker](https://docs.docker.com/engine/security/).
Rootless Docker также требует user namespaces и настройки отображения UID/GID:
[его требования](https://docs.docker.com/engine/security/rootless/).
Windows-версия Docker Desktop использует отдельный backend виртуализации, например WSL 2
или Hyper-V: [требования Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/).
Следовательно, одного запуска Windows-программы через Wine недостаточно для локальных контейнеров.

## Linux-окружения на Android

- [Termux](https://termux.dev/en/) работает без root и предоставляет Node.js, Git, Bash
  и Python. Это подтверждает доступность базовых инструментов, но не совместимость всего Кокпита.
- [PRoot-Distro](https://github.com/termux/proot-distro#limitations) даёт Linux userland
  без собственного ядра и без настоящих root-прав. Его поддержка OCI-образов не означает
  запуск Docker Engine: namespaces, cgroups и полноценный init он не предоставляет.
- [QEMU в режиме system emulation](https://www.qemu.org/docs/master/system/introduction.html)
  запускает гостевую ОС с собственным ядром. Его TCG выполняет программную эмуляцию;
  аппаратное ускорение требует отдельного доступного механизма виртуализации.
- В Android есть Linux Terminal с Debian в VM:
  [документация Android 16](https://source.android.com/docs/whatsnew/android-16-release#virtualization).
  Доступность зависит от устройства и прошивки:
  [документация для поддерживаемых устройств](https://developer.android.com/about/versions/15/release-notes).

Из требований Docker следует, что локальный Engine нужно оценивать в полноценной Linux-VM
либо на Android-хосте с нужными правами и функциями ядра. Одного root недостаточно для
гарантии совместимости. Docker внутри конкретной Android-VM здесь не проверялся.

## Что ограничивает автономное приложение

Для локального сервера отдельно проверяются запуск дочерних процессов, доступ к проектам,
совместимость бинарных зависимостей и механизмов изоляции исполнителей. ARM64-сборки
инструментов позволяют обойтись без перевода x86-инструкций там, где такие сборки доступны.

Длительная работа требует учёта Android lifecycle. Foreground service показывает уведомление
и имеет ограничения запуска и времени работы в зависимости от типа:
[документация Android](https://developer.android.com/develop/background-work/services/fgs).
Наличие такого сервиса не является гарантией непрерывной работы сервера и всех его процессов.

В Android 17 ограничения памяти приложений относятся ко всем target SDK. Устройство с
большим объёмом RAM также требует проверки лимитов конкретной прошивки:
[поведение Android 17](https://developer.android.com/about/versions/17/behavior-changes-all#app-memory-limits).
