# Конфигурация и boot установки плагинов

Приложение создаёт один PluginInstallService и передаёт его модулю плагинов. Версия
берётся из bounded обычного VERSION; reservedIds — полный SYSTEM. Installer recovery
выполняется до user scan/import, runtime связывается до обслуживания install API.
OnClose ждёт весь installer lifetime и durable callbacks до выхода процесса.

Пути задаются конфигурацией:

- COCKPIT_PLUGINS_DIR: пакеты, по умолчанию `<папка данных>/plugins`.
- COCKPIT_PLUGINS_DATA_DIR: данные, по умолчанию `<папка данных>/state/plugins`.
- COCKPIT_PLUGIN_INSTALLS_STATE_PATH: журнал, по умолчанию `<папка данных>/state/plugin-installs.json`.

До создания сервисов boot проверяет абсолютность и предков paths без следования по
ссылкам, отделение data/state от заменяемого дерева и корректность VERSION. Проверка
не создаёт roots при invalid config. Модуль создаёт dataDir до server import.

Второй owner или повреждённый installer state сохраняют встроенный API и безопасный
recoveryError. Соответствующие user trees не импортируются; неизвестный global state
не используется для сигналов или уборки. Корректная остановка во время native Git
сохраняет cancelled, пустой worker registry и освобождает lock после drain; следующий
boot видит тот же outcome. Native fixture удерживает настоящий Git посредством FIFO
в собственном bare HEAD и подтверждает отсутствие live групп до удаления root.

Тесты запускают отдельный app процесс, задавая все state/data paths в временном
корне. Рабочий сервер для внедрения изменений перезапускает владелец вручную.
Веб-интерфейс установки подключён к каталогу; его [проверяемый контракт](../web/plugin-install-ui.md).
