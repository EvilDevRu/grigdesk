# Выбор серверного ELF окном

Обозначения I/D/R и launcher описаны в [обзоре](server-binary.md).
Lease/token хранится по [контракту кэша](server-binary-cache.md),
каталоги CLI строятся по [общему PATH](server-binary-path.md).

Установка ELF не переключает окно. Обновлённое окно с runtime-version 4 поддерживает
явный выбор установленного файла либо прежнего комплекта R:

```sh
grigdesk-ctl desktop use-server /installation/bin/grigdesk-server
grigdesk-ctl desktop use-server /legacy/release
grigdesk-ctl desktop use-source /source/root --node /node/bin/node
```

Перед выбором закройте окно и остановите сервер вручную. Команда проверяет обе папки данных,
профили и целостность выбранной поставки. Живой владелец server.lock запрещает выбор;
команда не посылает ему сигналов. Для source-профилей требуется явный физический
FACTORY_PROFILES_DIR; выбор не переносит профили и не пишет настройки.

Descriptor v4 содержит ровно version, kind=binary, абсолютные binary/home и cliPaths.
Он не хранит packageId и кэшированный R. При первом переходе из source сохраняется каталог
выбранного Node, чтобы пользовательские CLI оставались доступны. Discovery nvm/CLI выполняется
при подготовке запуска; I/bin первый в PATH, поставляемый Node последний. v1/v2/v3 сохраняют
прежнее поведение. Установка нового окна сохраняет выбранный descriptor v3/v4.

Выбор публикует private runtime.json.previous и primary под общим select-lock с
PID/starttime/token. Повтор того же binary/D не стирает previous, но снова проверяет ELF.
Private runtime.json.transaction описывает предыдущие и новые bytes и прежний backup.
После обрыва loader/writer под тем же lock восстанавливает backup по primary: прежний primary
откатывает незавершённый выбор, новый primary завершает его. Иные bytes дают именованный
server_selection_conflict без затирания. Только доказанно мёртвый owner reclaimed; live,
unknown и прежний ownerless lock требуют проверки владельцем.

Загрузка адреса окна использует purpose=inspect и не материализует payload. Только supervisor
запрашивает purpose=start: runtime-info и prepare закрепляют packageId, а spawn передаёт
expect-package-id и preparation-token. Подмена ELF между prepare и spawn отвергается launcher;
повтор старта читает новую identity даже по тому же пути.

Preparation удерживается во время VPN/cwd/spawn. Каждая итерация supervisor освобождает свой
handle при abort, ошибке, внешнем сервере или повторном ожидании. После spawn окно ждёт точный
IPC ACK {type:grigdesk:preparation-adopted,packageId,token} своего child. Событие spawn и HTTP
не подтверждают передачу. До ACK lease защищает coordinator, после ACK сохраняется server owner.
Если ACK не пришёл, окно останавливает только своего ребёнка и ждёт exit; неизвестный исход
сохраняет lease консервативно. Для прежних runtime handle пустой.

Откат ELF выполняется отдельным установщиком; возврат к R/source — командами выбора выше.
Перезапуск живого сервера и GUI-проверку выполняет человек.
