# Дополнительные runtime-контракты

Основные знания читаются по живым ссылкам карт `docs/cockpit/*.md`; этот файл сохраняет
короткие runtime-инварианты, которым недостаточно одного заголовка карты.

## SSH-плагин

Ручной raw connect с паролем отправляет `application/octet-stream` только на localhost
или через HTTPS; пароль не хранится и не попадает в JSON. Human shell и agent exec —
разные режимы, SFTP доступен только человеку. Для подтверждений действует одна общая
очередь; origin-aware ответ идёт через `/api/ssh/approvals/:pid`.

Bridge-провайдеры — Claude, Codex, Kimi и Ollama. Доступ агента привязан к доверенному
attempt (trusted attempt), а у свободного чата task scope равен null. Вывод сервера
недоверенный: prompt injection не получает инструментов. Один ToolHost обслуживает все
сессии; Telegram fail-closed не видит SSH-подтверждения, старый PWA bundle также
fail-closed и не разрешает новое действие.

Публичные endpoints: `/api/ssh/connections`, `/api/ssh/host-key/:challengeId`,
`/api/ssh/sessions`, `/api/ssh/sessions/:sid/agent-access`,
`/api/ssh/sessions/:sid/terminal`, `/api/ssh/sessions/:sid/files`, `/api/ssh/audit` и
`/api/ssh/approvals/:pid`. Host key проверяется через TOFU/known-host; недоверенный вывод
сервера остаётся риском prompt injection.

## Запрет прямого SSH исполнителям

Настройка `blockDirectSsh` хранится как `providerSettings.<id>.blockDirectSsh` и меняется
существующим `POST /api/providers/:id/settings` с `confirmed: true`. При отсутствии ключа
запрет по умолчанию включён (`true`). Claude использует command-hook, Codex — command-hook,
Ollama — tool-filter, Kimi — network-sandbox и host fail-closed. После изменения
`providerSettings` сессию надо переоткрыть или restart.

Это граница для кооперативного агента, не защита от намеренного обхода через base64/sh или
собственный SSH-клиент. Она не зависит от permission mode и не отменяется режимом прав.
`SSH_AUTH_SOCK` остаётся доступен; Git по SSH не блокируется. После выключения запрета
журнал подтверждений не создаётся. Старый PWA получает `confirmation_required`.
Пользовательский `permissions.deny` сохраняется: оба ограничения действуют совместно.
Проверка выполняется с временным `CLAUDE_CONFIG_DIR` и отдельным config, включая deny.

Для Kimi host-режим при недоступной политике закрывается fail-closed с typed-ошибкой
`direct_ssh_policy_unavailable`. Режим contained даже при `blockDirectSsh: false` остаётся
закрыт network/egress-песочницей.

## Надзорный доступ к базам

Системный плагин `db` выключен по умолчанию. Профили хранят описание соединения в
приватном DB namespace, а пароль передаётся raw bytes, живёт только в памяти
server-owned сессии и не попадает в prefs, argv, env или audit. Соединение `via: ssh`
использует `forwardOut` живой SSH-сессии без локального порта; её закрытие немедленно
закрывает все зависимые DB-сессии и ожидания.

Один `supervised_db` доставляется всем исполнителям из общего work-tools registry.
`list` раскрывает только label, role и engine. Каждая попытка schema/query получает
решение общей очереди с `origin: 'db'`: внутренний отказ для отсутствующей сессии,
допуска, unknown и закрытых DDL/admin; внутреннее разрешение для доказанно безопасного
автопрочтения; иначе решение человека. Режим прав, remember и provider auto-allow этот
рубеж не обходят. Результат помечается недоверенным, снимает управляющие
последовательности и честно ограничивается по целым строкам и байтам. Allowlist-аудит
ведётся для всех исходов и хранится 30 дней.

Движки сканируются из `server/src/lib/db/engines/` и сами объявляют capabilities,
анализ, фактические права, read-only, оценку, исполнение и отмену. Ядро и Vue не
ветвятся по имени СУБД. HTTP-модуль session-only и live-gated, UI живёт в единственном
ToolHost и использует общий EventSource.

Проверки, которые сами исполняются на сервере БД, идут только там, где способны
изменить решение: оценка (`EXPLAIN`) и запрос прав снимаются с запроса, прошедшего
формальный фильтр, и никогда — с текста, где найдена табличная функция или запрещённая
конструкция; при выключенном авто-чтении их нет вовсе. Иначе ClickHouse ради структуры
`url()`, `s3()` или `remote()` сходил бы в сеть ещё до решения человека. Найденные
конструкции показываются в карточке отдельной строкой, разбор движка не может вынести
исключение мимо журнала, а текст длиннее 20 000 символов отклоняется до живой записи.

Отмена принадлежит движку, но её последствие описано общим правилом: `cancel` называет
способ — `query` (снят сам запрос), `wait` (команда атомарна и снимать нечего) либо
`connection` (запрос снят только вместе с соединением). Последнее закрывает сессию:
показывать в панели живой ту, по которой уже не пройдёт ни один запрос, нельзя. Служебным
командам — `KILL QUERY`, `SCRIPT KILL`, сторож времени пишущего запроса — нужен свой
канал: рабочий занят самим ответом, поэтому сессия выдаёт движку `openStream`, а второй
сокет мимо туннеля ушёл бы напрямую и обошёл рубеж. Все каналы сессии закрываются вместе
с ней.

Host-aware Bash policy запрещает штатный DB-клиент с внешним host, но сохраняет
localhost, loopback и unix socket; неизвестная форма блокируется только строгим
тумблером. Список имён покрывает и штатные алиасы — `mariadb`, `valkey-cli` и единый
бинарь `clickhouse` с подкомандой `client`; `clickhouse local` сети не открывает и
разрешён. Обёртки запуска снимаются до разбора: кроме `command`, `exec`, `nohup`, `env` и
`sudo` — это `setsid`, `time`, `nice`, `ionice`, `stdbuf` и `timeout` вместе с его
длительностью. Claude/Codex применяют server-owned hook, Ollama фильтрует до permission
mode. Kimi host не может удержать этот рубеж и при активной DB-политике fail-closed
возвращает `direct_db_policy_unavailable` до build/spawn во всех режимах прав;
contained по-прежнему закрыт network/egress-песочницей.

## Telegram-пульт и companion

Телеграм-пульт **смотрит, разблокирует и поручает**. Постоянная клавиатура задаётся как
`ReplyKeyboardMarkup` с `is_persistent` и `resize_keyboard`: 📋 Конвейер, 💬 Агент,
📥 Задачи, ⚙️ Ещё. `setMyCommands` использует scope `BotCommandScopeChat` только в личке.

Общий companion создаётся через `store/ensure` с `purpose: companion` и `taskId: null`.
Обычный ход имеет `mode: auto` и идёт без `companionTurn`; `dontAsk` и
`bypassPermissions` никогда не обходят запрос решения. Тихий прогресс использует
`sendChatAction` со значением `typing` каждые 30 секунд и кнопку «Стоп». Память управляется
через `/api/chat/compact` и `/api/chat/session/reset`; голос отвечает «услышал: …» в одном
ответе. `/api/chat/active` показывает обрыв при перезапуске.

UI-компаньоном владеет `CompanionHost`; события несут `companionTurn`, `logicalIdentity` и
`routingScope`. `speechSynthesis` по умолчанию выключен. Недоверенный текст не получает
инструменты или сессию.
