# Повторный deploy/install.sh без флага включает автозапуск обратно

`deploy/install.sh` решает про автозапуск при каждом прогоне, а не только при первой установке.
Флаг `--autostart`/`--no-autostart` главнее всего; без флага в терминале задаётся вопрос, а без
терминала (агент, CI, скрипт) берётся ответ по умолчанию — «да»: `systemctl --user enable --now`
и `loginctl enable-linger`. Автозапуск, выключенный в «Настройки → Сервер» или через
`systemctl --user disable grigdesk-server`, после такого прогона молча включается снова — например,
когда агент применяет правку юнита установщиком, как описано в
[контрактах рантайма](../reference/runtime-contracts.md).

Правило: перед прогоном установщика сверь `systemctl --user is-enabled grigdesk-server`; если там
`disabled`, запускай `deploy/install.sh --no-autostart`. Эта ветка сама делает `disable` и
`systemctl --user start`, живой сервер она не перезапускает.
