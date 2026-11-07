# Изолированная приёмка серверного SEA

Здесь сохранена приёмка прежнего каталога R и перехода с исходников.
Отдельная изоляция payload описана в [обзоре одиночного ELF](server-binary.md#сборка-и-приёмка).

`tests/server/sea/isolation.mts` распаковывает настоящий архив в `os.tmpdir()`.
В bwrap создаются отдельные user/pid/net/ipc/uts namespaces; checkout и HOME хоста
не монтируются. По умолчанию R подключён read-only, D доступен на запись; `/tmp` отдельный.
Отдельный writable-тест подключает только свою распакованную копию R на запись,
чтобы запрет mount не скрывал запись Python/npm.
Обычные host-утилиты и библиотеки ОС доступны. Синтетические passwd/group нужны
обычным Node API пользователя; настоящие профили машины в проверку не передаются.

Внешний `node` заменён проверяемой заглушкой exit97. Driver запускается вложенным
Node, сервер — настоящим SEA. Проба отдельно доказывает отсутствие checkout и его
родителя, exit97, EROFS при записи R и рабочий loopback. После каждого driver
настоящий `--check-runtime` подтверждает неизменность всего комплекта.

Окружение строится по allowlist: HOME/XDG, D, factory state/control/config/profiles,
проекты, credentials, фоновые сервисы и журналы принадлежат фикстуре. Основной и
мобильный порты ОС выбирает независимо. Существующие профили и модели не читаются.

| Проверка | Доказательство |
| --- | --- |
| Boot и `.env` | Настоящий CLI запускает ELF; второй сервер с тем же D получает78, первый жив; SIGTERM0 снимает lock. |
| Протоколы | API/SSE/WS/devices без сессии дают401, старые UI-пути404. Труба раздаёт запечатанный UI, обменивает ключ окна на сессию, обращается к SEA API; CLI device list и Python PTY работают. |
| Устройства | Настоящий TLS1.3-вход отделяет bootstrap; код привязывает сертификат, device-auth открывает API, отзыв даёт403/device_revoked. |
| Доступный на запись R | factory-route и npm из настоящего PTY, пользовательский Node первым/собственный последним, отсутствие pyc, npm prefix вне R, повторный boot и полный manifest. |
| Реестры и БД | Все provider/DB adapters перечислены; настоящий ClickHouse-клиент получает42 и посылает KILL QUERY нужному query_id локальному HTTP-сервису. |
| Ход агента | `/api/chat` запускает синтетический Claude CLI; он выполняет initialize/tools/list/tools/call через настоящий packaged MCP и work IPC. Поддельный project scope и неверный nonce отвергаются. |
| Пользовательский плагин | ESM server.js импортирует соседний модуль, использует lifecycle и dataDir; onClose оставляет проверяемый результат в D. |
| Helpers и движок | GLB создаётся с fd и преобразованием размера; supervisor завершает свой leader при disconnect, соседний процесс жив; Bash вызывает обе compatibility wrappers. |
| Desktop IPC | Настоящий SEA выходит75 по restart API; новый SEA того же R выходит0 при disconnect и снимает lock. |
| Перенос | Boot/DB/plugin/MCP/GLB/supervisor/Bash повторяются в R с пробелами при закрытом checkout и read-only mount. |

Синтетический CLI не вызывает модель; локальная БД сохраняет настоящий HTTP-протокол.
Тестовый код driver находится отдельно в `/suite`; код сервера приходит только из архива.
Наличие готового архива и bwrap обязательно, отсутствие — ошибка, а не skip.
Сценарии с процессами, сокетами и сроками помечены нестабильными по времени.
Для выпуска TLS-сертификата нужен OpenSSL и его публичный openssl.cnf; namespace
подключает конфигурацию только для чтения, приватные системные ключи не монтируются.

```bash
npm_config_cache=/path/to/npm-cache \
GRIGDESK_ARTIFACTS_DIR=/path/to/test-artifacts NODE_TEST_MAX_RSS_MB=4096 \
  timeout 900 npm --prefix server run test:sea -- --release-dir /absolute/path/to/release
```

GUI `tests/desktop/e2e/server-sea.e2e.mts` и systemd `tests/server/sea/service.e2e.mts`
не входят в автоматический slow glob: их запускает владелец вне песочницы по командам
из [desktop](sea-desktop.md) и [launch](sea-launch.md). DeepSeek probe отложен до
интеграции отдельного бинарника; основной SEA проверяется с недоступным адаптером.
