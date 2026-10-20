# Запуск и регистрация готового SEA-комплекта

Здесь сохранён запуск прежнего каталога R и перехода с исходников.
Launcher и установка нового варианта описаны в [обзоре одиночного ELF](server-binary.md).

`R/bin/grigdesk-ctl run` запускает `R/server/grigdesk-server` на переднем плане.
Shell-библиотека выбирает собственный `runtime/node/bin/node` для вспомогательных команд,
очищает NODE_OPTIONS до его первого вызова и проверяет R настоящим `--check-startup`.
Пропажа Node, сервера либо повреждение manifest — отказ без fallback в PATH.
Успешная проверка кэшируется только внутри текущего shell; внешний env не может её подменить.

Для ручного запуска и рестарта вложенный Node исполняет helper launch-sea-server.
Он читает `.env` как данные штатным парсером до bootstrap сервера, передаёт
NODE_EXTRA_CA_CERTS и заменяет себя через execve. PID/stdio сохраняются, NODE_OPTIONS
удалён. Служебные аргументы обходят чтение D. Source сохраняет Node, прежние аргументы
env-file и вход app.ts. Исторический способ запуска restart.sh
сохраняется. Ограничения единой команды для хода агента остаются прежними.

Регистрация пакета через deploy/install.sh не запускает npm, исходную сборку b24,
сборку web или подготовку Python. Готовый b24 связывается с каталогом CLI пользователя.
Пишутся только настройки установки, ссылки и D; сам R остаётся неизменным.
Source-установка сохраняет прежние подготовительные шаги.

В unit готового пакета ExecStart указывает на SEA, WorkingDirectory — на R/server,
PATH содержит вложенный Node последним, после пользовательских инструментов.
Пути R с пробелами заключаются в кавычки. Для SEA добавляются
`UnsetEnvironment=NODE_OPTIONS` и `PYTHONDONTWRITEBYTECODE=1`; EnvironmentFile и раннее окружение, включая
NODE_EXTRA_CA_CERTS, сохраняются. VPN-ворота, loopback, Restart, KillMode=mixed и бюджет
остановки не заменяются новым механизмом. При уже отвечающем GrigDesk установщик не
стартует соседний unit, как и в source-режиме.

`sea-launch.test.js` проверяет эти ветки на синтетическом R/HOME/D и проверенных заглушках
systemctl/npm/Python. Снимок состава до/после подтверждает отсутствие записи в R.
Проверка read-only mount выполняется отдельно в namespace.
Запись кэшей и глобального npm ограничена [окружением детей](sea-runtime-checks.md).

Настоящая служба проверяется владельцем вне песочницы тестом
`tests/server/sea/service.e2e.mts`. Он создаёт отдельный transient user-unit со случайным
именем `grigdesk-sea-test-<UUID>.service`, временными HOME/D и двумя независимыми портами.
`env -i` исключает окружение user manager. Проверяются защищённый API, путь `/proc/exe`,
остановка своего unit, освобождение lock и целостность R. Unit основной установки не меняется.

```bash
GRIGDESK_SEA_SYSTEMD=1 GRIGDESK_SERVER_RELEASE_DIR=/absolute/path/to/release \
GRIGDESK_ARTIFACTS_DIR=/path/to/test-artifacts NODE_TEST_MAX_RSS_MB=4096 \
  timeout 180 bash tests/run-node-tests-safe.sh --test --test-concurrency=1 \
  tests/server/sea/service.e2e.mts
```

Тест не входит в обычную команду test:sea и требует явного флага. Отсутствие флага —
ошибка. Его подготовка и проверка типов не означают прохождения настоящего systemd.
