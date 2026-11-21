# Фабрика GrigDesk

Фабрика выполняет опубликованные маршруты. Go-исходники и тесты лежат
в `../utilities/factory/`. В `engine/` хранится публичный ресурс профилей
`lib/delivery_contract.py`. Bash-хуки проекта загружает Go-движок.

## Работа с фабрикой

```bash
grigdesk-ctl build factory
bin/factory capabilities --format json
bin/factory profile-check <PROFILE> --quick
bin/factory route --profile <PROFILE> --routes-dir /path/to/routes current
```

Команды `bin/factory` в примере выполняются из корня GrigDesk.
Для задач используйте карточки GrigDesk и CLI `pipeline`.
Для редактора и управления маршрутами используйте интерфейс GrigDesk или `routes`.

Go рассчитан на сохранённые попытки route-v2. Попытки, закреплённые за прежним
движком, требуют перепривязки после остановки. Маршрут, курсор и журнал
сохраняются.

- [Устройство движка](../docs/engine/ENGINE.md)
- [Контракт профиля](../docs/engine/PROFILE-CONTRACT.md)
- [Подключение проекта](../docs/engine/NEW-PROJECT.md)
- [Запуск и работа конвейера](../docs/grigdesk/guide/ru/pipelines.md)
