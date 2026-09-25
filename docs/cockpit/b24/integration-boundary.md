# Граница B24

Доска и действия используют локальный `B24Client`, медиа — локальный pipeline, вход в
фабрику — `engine/bin/factory`, CLI — `bin/b24`. Резервный
Python-dashboard тоже использует Cockpit `B24Client` и хранилище кредов, но держит отдельный
cookie jar, чтобы два процесса не перезаписывали один файл. Прямых путей к внешнему checkout
в рабочем коде нет; внешние host hooks/settings/containers находятся вне репозитория.
Полный контракт авторизации, HTTP и мутаций — в [b24.md](README.md).

Источник до переноса: docs/cockpit/architecture.md § Граница B24
