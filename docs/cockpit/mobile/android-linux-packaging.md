# Упаковка Linux-окружения в Android-приложение

Проверено 2026-10-13 по DroidDeck, commit
`b74edb7e8dba1d956c0b286914b4e860af877811`. Это описание существующего внешнего проекта,
а не подтверждение запуска Кокпита на телефоне.

## Устройство DroidDeck

[LinuxRuntime.java](https://github.com/Droid-Deck/DroidDeck/blob/b74edb7e8dba1d956c0b286914b4e860af877811/app/src/main/java/com/droiddeck/launcher/runtime/LinuxRuntime.java)
хранит glibc ARM64 rootfs в приватном каталоге приложения и запускает команды через PRoot.
Сам PRoot и его загрузчик поставляются как `libproot.so` и `libproot-loader.so` в нативной
части APK. Сессией владеет Android foreground service.

[Документ патчей](https://github.com/Droid-Deck/DroidDeck/blob/b74edb7e8dba1d956c0b286914b4e860af877811/tools/proot/PATCHES.md)
описывает адаптации системных вызовов, путей и операций с файлами, а также уменьшение
числа остановок ptrace. Запуск Linux-программ без root — реализованный подход;
ограничения Docker Engine сами по себе не означают невозможность такого окружения.

[README](https://github.com/Droid-Deck/DroidDeck/blob/b74edb7e8dba1d956c0b286914b4e860af877811/README.md)
описывает работу без root, установку runtime и настройку ограничения дочерних процессов.
Графические требования игрового приложения не являются измеренными требованиями серверного стека.

## Android-оболочка имеет значение

В [app/build.gradle](https://github.com/Droid-Deck/DroidDeck/blob/b74edb7e8dba1d956c0b286914b4e860af877811/app/build.gradle)
DroidDeck намеренно задаёт `targetSdkVersion 28`; комментарий связывает это с исполнением
файлов Linux rootfs из данных приложения. Копирование только архива rootfs не переносит
всю эту схему запуска в произвольный APK.

Текущий клиент Кокпита задаёт target SDK 36 в
[variables.gradle](../../../mobile/android/variables.gradle). Это факт существующего клиента,
а не ограничение выбора архитектуры отдельного нового приложения.

PRoot не добавляет собственное ядро, сетевые namespaces и изоляцию Docker. При переносе
готовых файловых систем OCI-образов остаётся отдельно организовать процессы, их соединения,
хранение данных и остановку. Совместимость конкретных серверов требует проверки на устройстве.
