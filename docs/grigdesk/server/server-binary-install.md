# Установка и откат серверного ELF

Раскладка I/D/R и argv определены в [обзоре сервера](server-binary.md),
выбор descriptor — в [контракте окна](server-binary-desktop.md).

В исходниках `grigdesk-ctl build server` собирает кандидат и вызывает этот установщик
с target `<корень>/bin/grigdesk-server` и releases в папке данных. `grigdesk-ctl build`
после сервера собирает веб и ставит окно; работающие компоненты команда не перезапускает.
Если descriptor уже v4 на этот ELF, новый packageId подхватится при следующем открытии окна.
Для отдельной цели `server` иначе печатается подсказка `grigdesk-ctl desktop use-server <ELF>`.
Полная сборка дополнительно сохраняет [отложенную привязку окна](build-server-selection.md):
[сборка одной командой](ctl-build.md).

Сборка, установка, выбор окна и перезапуск — отдельные действия. Установщик запускается
поддерживаемым Node машины установки или Node прежнего комплекта:

```sh
npm --prefix server run install:binary -- \
  --binary /candidate/grigdesk-server \
  --target /installation/bin/grigdesk-server \
  --releases-dir /data/runtimes/server/releases
```

Первые два пути обязательны. Без releases-dir используется папка данных, выбранная обычными
правилами GrigDesk. Установщик не меняет descriptor, настройки и историю, не останавливает сервер.

Под собственным directory lock установщик копирует ordinary ELF через O_NOFOLLOW в private
staging на filesystem target. Копия закрывается, получает 0555 и fsync. Только staged inode
проходит runtime-info и полный verify (SHA самого ELF, Node/ABI, два native bindings).
Пробы получают отдельные HOME/D/tmp/cache вне установки и окружение без ключей и loaders.
SHA и файловый отпечаток staged inode проверяются повторно после проб и backup.

До backup и публикации проверяется [совместимость с установленным DeepSeek/GLM](server-executor-install-guard.md)
по контракту из payload кандидата сервера. При несовместимости прежний сервер и receipt
сохраняются. Для нестандартного пути исполнителя есть `--deepseek-binary <ELF>`;
по умолчанию проверяется соседний `bin/deepseek`, если он установлен.
Флаг `--glm-mode api|coding-plan` выбирает фактический режим admission потребителя;
без него проверяется режим host-контракта. `grigdesk-ctl build` передаёт режим сам:
[правило выбора](server-install-glm-mode.md).

Чужие target, symlink и неправильные receipt отклоняются. Private receipt
`grigdesk-server.grigdesk-server.json` имеет режим 0600 и привязан к абсолютному target.
Старый target копируется без исполнения и сверяется с approved SHA; резерв лежит по пути
`releases/<SHA>/grigdesk-server`. Повреждённый backup не заменяется молча.

Receipt сохраняет прежние approved SHA при добавлении новой. Его fsync/rename предшествует
rename проверенного staged inode на target, поэтому сбой в этом промежутке допускает retry.
Работающий прежний ELF продолжает работать. После успеха в bin остаются только ELF и receipt.
Для отката передайте резервный ELF той же команде как candidate; все пробы повторятся.

JSON результата: packageId, sha256 и previous (путь к backup либо null). Квитанция не нужна
обычному запуску; она разрешает будущую замену установщику.

После установки `I/bin/grigdesk-ctl run` проверяет публичную metadata и передаёт управление
`I/bin/grigdesk-server`. Node/npm/исходная сборка не требуются. Для разбора JSON shell использует
системный Python 3 со стандартной библиотекой в изолированном режиме; пакеты не устанавливаются.
Повреждённый файл или metadata дают отказ. При отсутствии ELF сохраняется прежний вход source/v3.
Раннюю `.env`, включая `NODE_EXTRA_CA_CERTS`, читает сам launcher перед стартом своего Node;
`NODE_OPTIONS` удаляется. Служебные argv `run --version` обходят D.

Обычные команды CLI исполняют собранный helper из подготовленного R собственным Node.
Окно и внешние команды принадлежат I/bin, а VERSION читается из R; standalone unit
проверяется с cwd I. Для source и прежнего R сохраняется cwd <root>/server и окно в <root>/bin.
Shell держит preparation до завершения helper-а и освобождает его также при отказе;
защита `server restart` из хода агента сохраняется. `b24` выбирается из `I/bin` как отдельная
готовая утилита. Команды разработки требуют исходной установки.

`bash I/deploy/install.sh --unit-only` только записывает описание службы и вызывает
`systemctl --user daemon-reload`. В standalone unit: ExecStart — внешний `I/bin/grigdesk-server`,
WorkingDirectory — I. Пути I с пробелами заключаются в кавычки. EnvironmentFile, VPN-ворота
в ExecStartPre, `UnsetEnvironment=NODE_OPTIONS`, Restart, код 78 и KillMode=mixed сохраняются.
Обычная регистрация ELF также обходит npm/web/media build и не запускает соседнюю службу,
если GrigDesk уже отвечает на loopback-порту. Установку и запуск настоящей службы выполняет человек.
