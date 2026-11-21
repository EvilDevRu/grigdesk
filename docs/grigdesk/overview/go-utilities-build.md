# Сборка семи Go-утилит

Модуль `grigdesk.local/tools` объединяет команды `tracker`, `routes`, `pipeline`, `voice`,
`grigdesk-relay`, `grigdesk-ctl` и `grigdesk-maintenance`. Исходники лежат в
`utilities/<имя>/cmd/<имя>` и `utilities/<имя>/internal/`, общие пакеты — в
`utilities/internal/`. Сборщик запускается с Go 1.27.4 на целевой машине.
В том же модуле находятся движок и тесты в `utilities/factory/`.
Цель `grigdesk-ctl build factory` собирает его в `bin/factory` для проверки кандидатной поставки.

```bash
tools/build-go-utilities.sh "$PWD/bin/utilities"
```

Сборщик читает версию из корневого `VERSION`. Он сначала собирает и запускает все семь файлов
в промежуточном каталоге, затем заменяет записи назначения через `rename`.
В заданном каталоге получаются `tracker`, `routes`, `pipeline`, `voice`, `relay`,
`ctl` и `maintenance` с правами 0755. Перезапись файлов под контролем Git запрещена.
Если передать корневой `bin/` рабочей копии, сборщик использует его подкаталог `utilities/`.
Ссылка `~/.local/bin/grigdesk-ctl` в исходной установке указывает на `bin/utilities/ctl`.

Каждый бинарник выводит один JSON через `--runtime-info --json`. Поля `schema` (1),
`kind` (публичное имя команды), `version`, `runtime` (`go`), `go`, `os` и `arch` доступны в пустом окружении.
Архитектура используется в обозначениях Go, например `amd64` и `arm64`. У tracker, routes,
pipeline и relay флаг `--license` выводит лицензии GrigDesk и Go.

Для проверок можно указать отдельный абсолютный каталог. Сборка релиза использует тот же Go 1.27.4,
включает пять утилит в server, `grigdesk-ctl` в control и maintenance в отдельный gzip.
Готовые утилиты запускаются напрямую из своего каталога. Приёмка подписанного комплекта требует
нативных проверок на каждой платформе.
