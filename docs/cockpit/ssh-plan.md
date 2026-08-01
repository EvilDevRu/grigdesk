# План отдельного SSH-раздела Cockpit

Статус: **проект; реализация не начата**

Составлен: **2026-08-01**

Первый рабочий релиз: **сохранённая парольная авторизация, подтверждение host key человеком,
живые переподключаемые терминальные сессии и чат с ручной вставкой команд**.

Этот документ одновременно задаёт план реализации и обязательный security-контракт. Формулировки
«должен», «только» и «никогда» ниже являются условиями приёмки, а не пожеланиями.

## 1. Главная продуктовая поправка

На целевых серверах основной способ входа — пароль. Поэтому:

- парольная авторизация является **режимом по умолчанию и обязательной частью MVP**;
- сохранённый пароль не считается временным fallback и не требует последующей миграции на ключ;
- форма добавления сервера сразу открывается в режиме «Пароль»;
- Cockpit не навязывает ключи и не блокирует функции для парольных серверов;
- импорт существующего ключа и отдельный Ed25519-ключ на сервер остаются дополнительными режимами
  после стабилизации password-first потока;
- выбор способа авторизации фиксируется для сервера явно: OpenSSH не перебирает неожиданно ключи,
  агенты и другие источники учётных данных.

Для пользователя «пароль» включает обычный OpenSSH `password` и распространённый одношаговый
`keyboard-interactive`, если сервер просит тот же единственный пароль. Это два разных строго
выбранных подрежима, а не fallback-цепочка OpenSSH. Обычный `password` обязателен безусловно;
`keyboard-interactive` допускается в первый релиз только после этапа 0 с закреплением точного
prompt и доказательством одноразовой выдачи секрета. Неизвестный, изменившийся или второй prompt
никогда не получает сохранённый пароль автоматически. Многошаговый PAM/MFA остаётся human-only
экспериментом до отдельной приёмки и не входит в MVP.

## 2. Цель

Добавить в Cockpit самостоятельный раздел для ручной работы с SSH-серверами с планшета:

- список сохранённых серверов без привязки к проектам;
- зашифрованное хранение паролей и, позднее, ключей;
- проверка и закрепление host key каждого сервера;
- терминальные сессии, переживающие сон планшета, закрытие вкладки и перезапуск основного Cockpit;
- явное переподключение браузера к уже работающей сессии;
- встроенный чат, который предлагает команды текстом, но не получает управление терминалом;
- явная передача выбранного фрагмента вывода модели после локального маскирования и подтверждения.

Маршруты интерфейса на отдельном доверенном SSH-origin:

- `/ssh` — серверы, vault и активные сессии;
- `/ssh/session/:id` — терминал и сворачиваемая панель чата.

Раздел не связан с реестром проектов, профилями Factory, worktree или маршрутами агентов.

## 3. Неподвижные границы безопасности

### Агенту запрещено

- создавать SSH-сессию через Broker;
- получать список секретов, пароль, passphrase, приватный ключ или мастер-пароль;
- читать терминальный поток, scrollback или выделение без отдельной отправки человеком;
- вводить данные в терминал напрямую;
- выполнять предложенную команду автоматически;
- подтверждать host key;
- включать режим «разрешить всё до конца сессии»;
- получать SSH/Broker MCP-инструмент, внутренний API-токен или attach capability;
- инициировать повторный SSH-вход после обрыва удалённого соединения.

Ответ агента в SSH-чате — только текст и карточки команд. Даже безопасная команда попадает в
терминал лишь после клика человека, причём без `Enter`. Нажатие `Enter` всегда остаётся отдельным
действием человека.

### Что система защищает

- сохранённые учётные данные от чтения основным процессом Cockpit и процессами агентов;
- broker-cookie, terminal WSS и сохранённые подключения от изменяемых checkout-кода, обычного
  frontend и proxy Cockpit;
- Broker API от широких `internalToken`, `cliToken` и обычной cookie-сессии Cockpit;
- терминал от автоматического чтения и ввода со стороны чата;
- пароль от попадания в argv, env, `.env`, логи, историю чата и браузерное хранилище приложения;
- соединение от незаметной смены host key;
- SSH-процесс от произвольных клиентских опций, forwarding и shell injection.

### Что система не обещает

- защиту при компрометации root, ядра, браузера или уже разблокированного Broker;
- защиту от вредоносного расширения браузера, компрометации отдельного доверенного SSH-origin или
  ввода мастер-пароля человеком в поддельную страницу вместо этого origin;
- безопасность удалённого сервера после успешного входа;
- сетевой firewall для всех CLI-агентов: они уже имеют общий сетевой доступ, но не должны иметь
  доступа к сохранённым соединениям и их учётным данным;
- автоматический отзыв публичного ключа из удалённого `authorized_keys`;
- сохранение SSH-сессии после перезапуска самого Broker.

Обычные ключи в `~/.ssh`, уже разрешённые на тех же серверах, остаются отдельным обходным путём.
Перед выпуском их нужно либо отозвать на серверах, либо доказанно скрыть от всех агентских
процессов. Одна изоляция Broker этот старый доступ не отменяет.

## 4. Целевая архитектура

```text
браузер
  ├─ обычный Cockpit-origin
  │    ├─ обычная cookie Cockpit
  │    └─ только top-level переход с одноразовым launch grant
  │
  └─ отдельный доверенный SSH-origin: /ssh, /ssh/session/:id
       ├─ root-owned статический UI bundle
       ├─ host-only outer-cookie gateway
       └─ отдельная короткая broker-cookie после unlock
                         │ HTTPS/WSS; другой origin
                         ▼
root-owned cockpit-ssh-gateway
  ├─ отдельный service user без доступа к vault/runtime
  ├─ обслуживает только SSH UI и фиксированные HTTP/WSS-маршруты
  ├─ не разбирает и не логирует secret-bearing body/terminal frames
  └─ основной Cockpit не находится в транспортном пути SSH
                         │ loopback only
                         ▼
cockpit-ssh-broker 127.0.0.1:8151
  ├─ отдельная browser-auth и CSRF/Origin-защита
  ├─ vault в памяти только после step-up unlock
  ├─ CRUD серверов и host key policy
  ├─ фиксированный запуск OpenSSH
  ├─ PTY/tmux, attach, resize, TTL и scrollback в памяти
  └─ audit без команд, вывода и секретов
                         │
                         ▼
                  удалённые SSH-серверы
```

Отдельный origin — обязательная граница, а не косметический hostname. В production root-owned
gateway принимает существующий внешний HTTPS-порт и разводит по точному SNI/`Host` обычный
Cockpit-origin и SSH-origin; новый внешний порт не открывается. Обычный Cockpit остаётся на
loopback и не видит broker-cookie, CSRF, secret-bearing body или terminal bytes. Если отдельный
origin, доверенный TLS leaf и такое разведение нельзя развернуть, SSH-раздел fail closed и не
откатывается к proxy внутри основного Cockpit.

TLS private key для SSH-origin и возможность выпустить сертификат для этого имени недоступны
основному Linux-пользователю и агентам. Существующий user-owned CA нельзя считать trust anchor для
SSH-origin без переноса его signing capability в root-owned контур. UI не встраивается в iframe,
запрещает embedding через CSP и открывается из Cockpit только top-level переходом. Обычный
service worker Cockpit не имеет scope на SSH-origin.

Если перед домашним gateway есть внешний HTTPS ingress, для SSH-origin он либо делает L4/SNI
passthrough до доверенного gateway, либо сам включается в root-owned trusted computing base с теми
же запретами на body/frame logging и доступ агентов. TLS-терминация в обычном Cockpit/Vite proxy
или ином изменяемом приложении запрещена. Входящий SSH-порт на домашней машине при этом не нужен.

Broker работает от отдельного заблокированного пользователя `cockpit-ssh`. У него нет login-shell,
`sudo`, доступа к рабочим каталогам, чатам, проектам и домашнему каталогу основного пользователя.

Исходники Broker находятся в репозитории для разработки, но production-копия устанавливается в
root-owned `/opt/cockpit-ssh-broker`. Сервис никогда не запускает код прямо из изменяемого агентом
checkout.

Gateway и SSH UI входят в ту же доверенную release-цепочку и устанавливаются root-owned отдельно
от обычного web bundle Cockpit. Агентский checkout, `deploy/install.sh`, restart основного Cockpit
и его frontend не могут заменить работающий SSH UI/gateway. Gateway работает от отдельного
locked-пользователя `cockpit-ssh-web`, не входит в группу `cockpit-ssh` и общается с Broker только
по loopback allowlist.

## 5. Владение данными и процессами

| Объект | Владелец | Место | Доступ основного Cockpit |
|---|---|---|---|
| Код production Broker | `root:root` | `/opt/cockpit-ssh-broker` | Только чтение публичных файлов ОС; без записи |
| Код gateway и SSH UI | `root:root` | `/opt/cockpit-ssh-gateway` | Нет записи; обычный Cockpit не проксирует SSH-трафик |
| TLS key SSH-origin | `root:cockpit-ssh-web` | root-owned каталог ingress | Нет |
| Vault | `cockpit-ssh` | `/var/lib/cockpit-ssh/vault.*` | Нет |
| Канонические host keys | `cockpit-ssh` | В зашифрованном vault | Нет |
| Производный `known_hosts` | `cockpit-ssh` | `/var/lib/cockpit-ssh/known_hosts` | Нет |
| Audit | `cockpit-ssh` | `/var/lib/cockpit-ssh/audit.*` | Нет прямого чтения |
| Runtime/FIFO/tmux socket | `cockpit-ssh` | `/run/cockpit-ssh/` | Нет |
| SSH и tmux-процессы | `cockpit-ssh` | cgroup system service | Нет управления |
| Карточки серверов в UI | Браузер после unlock | Только память вкладки | Не сохраняются в Pinia persistence/storage |
| Пароль в форме | Браузер до отправки | Только память поля | Очищается сразу после ответа Broker |

Обычный Cockpit хранит только конфигурацию ссылки на SSH-origin и выпускает короткий одноразовый
launch grant после обычной аутентификации. Grant даёт лишь доступ к locked/setup экрану, не
создаёт broker-auth, не открывает vault и не позволяет создать SSH-сессию.

Каталоги данных создаются с `0700`, файлы — с `0600`, процесс работает с `UMask=0077`.
`known_hosts` может оставаться в нативном формате OpenSSH: он не содержит паролей, но всё равно
недоступен другим пользователям.

## 6. Vault и recovery

### Формат

1. Vault имеет случайный `vaultId`, версию схемы, монотонные `generation` и `authEpoch`,
   authenticated manifest, обёртки DEK и набор зашифрованных объектов.
2. Setup создаёт vault через exclusive create; при двух конкурентных setup ровно один получает
   success, второй — `409`, не перезаписывая результат.
3. При setup Broker генерирует случайный DEK. Из отдельного мастер-пароля через версионированный
   `scrypt` выводится KEK, который оборачивает DEK через AEAD/AES-256-GCM.
   Версия/salt/параметры KDF входят в authenticated metadata, а до вычисления проходят жёсткие
   верхние/нижние bounds, чтобы подмена файла не вызвала memory/CPU DoS.
4. Каждая запись сервера и каждый секрет шифруются DEK с отдельным случайным nonce. AAD включает
   `vaultId`, версию схемы, kind объекта, ID и revision объекта; ciphertext нельзя переставить
   между полями или вернуть к старой revision незаметно.
5. Authenticated manifest связывает текущую `generation`, revision и digest точного ciphertext
   каждого объекта. Смешивание старого корректного ciphertext с новым manifest приводит к отказу.
6. Все мутации проходят через единственную writer queue Broker и межпроцессный lock. Клиент
   передаёт ожидаемую `generation`/revision; stale mutation получает `409`, а не last-write-wins.
7. Commit всей логической транзакции выполняется атомарным snapshot: временный файл в том же
   каталоге с `0600`, `fsync`, `rename`, затем `fsync` каталога. Recovery, смена обёрток и ротация
   credential не могут коммититься частично.
8. Повтор nonce, ошибка тега/digest, неизвестная версия, разрыв generation или незавершённый temp
   приводят к fail-closed recovery path, а не к частичному чтению.

Мастер-пароль не сохраняется. DEK существует только в памяти Broker ограниченное время и
стирается настолько, насколько это практически возможно в Node.js. Документация не должна
обещать гарантированное обнуление иммутабельных JS-строк; вместо этого секреты нужно держать в
`Buffer`, не копировать и сокращать время жизни.

AEAD не обещает обнаружить возврат **всего** vault к более старой, но внутренне корректной
резервной копии тем, кто уже может переписать весь state. Agent-boundary запрещает агентам такую
запись; root-компрометация вне threat model. Restore старого snapshot поэтому является отдельной
offline-операцией в maintenance mode: показывает `vaultId`/generation, требует подтверждения,
создаёт новый случайный auth instance ID, повышает snapshot `authEpoch` перед возвратом в работу и
отзывает все browser-сессии. Поэтому cookie от исходного и старого snapshot не оживает после
restore. Тихого restore поверх живого Broker нет.

### Recovery-код

При setup создаётся отдельный случайный recovery secret. Полученный из него recovery KEK второй
раз оборачивает тот же DEK. Человеку код показывается один раз с предложением распечатать или
сохранить офлайн; приложение не пишет его в local/session storage.

Recovery позволяет задать новый мастер-пароль, но не возвращает старый. Каждый успешный recovery
в одной транзакции создаёт **новый** recovery secret/wrapper, инвалидирует старый код, повышает
`authEpoch` и показывает новый код ровно один раз. Старый код после commit не работает.

Ротация мастер-пароля переоборачивает DEK и не перешифровывает каждую запись. Она также повышает
`authEpoch`, отзывает старые browser-cookie/CSRF/controller leases и выдаёт замену только
инициировавшей заново подтверждённой сессии. Ответ с recovery-кодом получает
`Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`; SSH-origin не
регистрирует service worker и не допускает попадания ответа в Cache API или HTTP cache.

### Автоблокировка

Начальные безопасные значения, которые затем можно вынести в настройки Broker:

- DEK блокируется после 15 минут без привилегированной операции;
- browser-auth Broker имеет idle TTL 30 минут и absolute TTL 8 часов;
- ручная или автоматическая блокировка удаляет DEK из памяти, повышает lock epoch, инвалидирует
  management-сессии, CSRF и controller leases и закрывает attach WebSocket;
- уже аутентифицированный SSH-процесс при блокировке не завершается: пароль ему больше не нужен;
- закрытые viewer не означают остановку SSH: процесс остаётся detached;
- для нового SSH-входа или повторного attach после блокировки снова требуется мастер-пароль.

## 7. Password-first пользовательские потоки

### 7.1. Первая настройка

1. Человек после обычного входа переходит top-level ссылкой на `/ssh` отдельного SSH-origin.
2. Одноразовый launch grant создаёт только outer-session gateway и сразу расходуется.
3. Broker сообщает только состояние `not_initialized`, не раскрывая данные, и выдаёт
   operation-bound pre-auth challenge для `setup`.
4. Человек задаёт отдельный мастер-пароль и подтверждает его.
5. Broker через exclusive create создаёт vault и показывает recovery-код один раз.
6. Человек явно подтверждает, что сохранил recovery-код офлайн.
7. Broker выдаёт короткую собственную browser-сессию и новый CSRF secret.

Пароль Cockpit и мастер-пароль vault не объединяются: компрометация обычной долгой cookie Cockpit
не должна автоматически открывать сохранённые серверы.

### 7.2. Добавление парольного сервера

Форма по умолчанию содержит:

- название;
- hostname или IP без `ssh://`, `user@` и встроенных опций;
- порт, по умолчанию `22`;
- имя пользователя;
- теги;
- режим `Пароль`;
- write-only поле пароля;
- явный выбор «сохранить зашифрованно» или «спрашивать при каждом подключении».

Основной сценарий — сохранить пароль зашифрованно. Режим «спрашивать каждый раз» полезен для
редких серверов, но не заменяет основной сценарий.

После заполнения человек нажимает «Получить fingerprint (host key)». Только этот клик разрешает Broker
сделать preflight к указанному адресу. UI показывает алгоритм, SHA-256 fingerprint и инструкцию
независимой сверки. До клика «Fingerprint сверил, доверяю» запись нельзя использовать для SSH.

`ssh-keyscan` не доказывает подлинность сам по себе. Он лишь получает кандидат, поэтому
подтверждение должно быть отдельным осознанным действием человека.

### 7.3. Подключение

1. Человек нажимает «Подключиться» на карточке сервера.
2. Если vault заблокирован, UI просит мастер-пароль и не продолжает автоматически после ошибки.
3. Broker проверяет browser-auth, CSRF, revision записи и закреплённый host key.
4. Broker проверяет выбранный **один** auth method: `password` или закреплённый
   `keyboard-interactive`; OpenSSH не переключается между ними после ошибки.
5. Broker расшифровывает пароль только в памяти и создаёт одноразовый канал для `SSH_ASKPASS`.
6. Broker запускает фиксированный OpenSSH-сеанс внутри PTY/tmux.
7. В `password` mode сохранённый пароль выдаётся helper один раз. В
   `keyboard-interactive` mode он выдаётся автоматически только при точном совпадении с ранее
   подтверждённым prompt; неизвестный prompt требует отдельного решения человека, а второй
   завершает MVP-сеанс как unsupported.
8. После единственной выдачи рабочий буфер очищается, capability уничтожается.
9. Терминал открывается только для инициировавшей browser-сессии.

Неверный пароль не вызывает бесконечных попыток. Сессия завершается понятной ошибкой, после чего
человек отдельно выбирает «Повторить» или «Обновить пароль».

### 7.4. Ротация и удаление пароля

- API никогда не возвращает пароль, даже сразу после записи.
- UI не подставляет маску вроде `********` как значение поля.
- Отсутствующее secret-поле означает «не менять», а не «стереть».
- Ротация выполняется отдельным write-only действием с новым паролем.
- Удаление сохранённого пароля — отдельное подтверждаемое действие; сервер остаётся в режиме
  «спрашивать при подключении» либо переводится человеком на другой способ авторизации.
- Ответ API содержит только `credentialState`, дату обновления и тип авторизации.

## 8. Независимая авторизация Broker

Обычная cookie Cockpit нужна только для выпуска одноразового launch grant на SSH-origin; Broker её
не получает и не доверяет ей. Grant имеет фиксированные audience/redirect, TTL не более 30 секунд,
однократное расходование и привязку к ID/epoch обычной Cockpit-сессии. Он создаёт outer-session
gateway, но не broker-auth. Компрометированный основной Cockpit может открыть locked-экран, однако
без мастер-пароля не может unlock, получить broker-cookie или использовать сохранённый credential.
Grant доставляется top-level `form_post`, не query/fragment, не пишется в access log/Referer и
после расходования завершается `303` на чистый URL.

Обязательный контракт:

- `setup`, `unlock` и `recovery` имеют собственный rate limit и задержку после неудач;
- перед каждой pre-auth мутацией browser получает случайный одноразовый challenge, связанный
  server-side с outer-session ID/epoch, точным action, текущим auth instance и коротким TTL;
- challenge читается только JS доверенного SSH-origin, хранится в памяти, расходуется даже при
  неуспешной попытке и не подходит для другого action, вкладки или outer-session;
- setup использует exclusive create; setup/unlock/recover races дают один commit и явный `409`;
- успешный unlock выдаёт случайную host-only `__Host-` cookie с `Secure`, `HttpOnly`,
  `SameSite=Strict`, `Path=/`; HTTP не принимается, кроме отдельного loopback-only dev fixture без
  реальных credentials;
- broker-session связывается с outer-session ID/epoch, `authEpoch` и случайным auth instance ID;
  logout, logout-all, password change или user switch обычного Cockpit инвалидируют outer-session,
  а gateway отзывает связанную broker-session при следующем запросе/WS и через push revocation;
- изменяющие запросы требуют отдельный CSRF secret из памяти вкладки; точный настроенный
  SSH-`Origin` проверяется на **каждом** mutating HTTP-запросе и WebSocket upgrade;
- gateway пропускает только известные методы и пути, ограничивает размеры тел и кадров, удаляет
  outer/обычную Cockpit-cookie, `internalToken`, `cliToken`, произвольный `Authorization` и все
  неразрешённые заголовки; Broker получает только свою cookie и allowlisted protocol fields;
- Broker сам отвергает внутренние токены и обычную Cockpit-cookie, даже если gateway ошибся;
- secret-bearing body и terminal frames gateway проксирует потоком без JSON-разбора,
  body/frame-логирования, retries и crash dump;
- recovery, lock, auth expiry и смена security epoch закрывают management/terminal WS, отзывают
  controller leases и CSRF; уже запущенный SSH остаётся detached;
- страница, получение списка серверов, ответ агента или восстановление WebSocket сами по себе
  никогда не создают новый SSH-процесс.

Gateway не доверяет одному только подписанному grant бесконечно: outer-session имеет короткий TTL,
проверяемый session epoch и server-side revocation. Переиспользование launch code, challenge,
старой cookie/CSRF после recovery или cookie от другого origin всегда отклоняется.

Root-owned SSH-origin защищает рабочий поток от подмены обычным frontend/proxy, но не лечит
фишинг: вредоносная страница Cockpit может нарисовать похожую форму и попросить мастер-пароль.
Документация и UI обязаны показывать точный SSH-origin, а человек — вводить vault secret только
там. Защита от сознательного ввода в неправильный origin не обещается.

## 9. Модель данных и API

### Запись сервера

Логическая схема до шифрования:

```json
{
  "id": "uuid",
  "revision": 3,
  "endpointRevision": 2,
  "label": "production-db-1",
  "host": "10.0.0.12",
  "port": 22,
  "username": "admin",
  "tags": ["production", "db"],
  "auth": {
    "kind": "password",
    "method": "password",
    "credentialState": "saved",
    "credentialUpdatedAt": "2026-08-01T00:00:00.000Z",
    "keyboardInteractivePromptFingerprint": null
  },
  "hostKeys": [
    {
      "algorithm": "ssh-ed25519",
      "publicKey": "AAAAC3NzaC1lZDI1NTE5AAAA...",
      "fingerprint": "SHA256:...",
      "endpointRevision": 2,
      "verifiedAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "createdAt": "2026-08-01T00:00:00.000Z",
  "updatedAt": "2026-08-01T00:00:00.000Z"
}
```

Секрет хранится отдельным зашифрованным объектом и никогда не входит в DTO ответа. Полный
нормализованный public host key хранится в vault как канонический trust anchor; fingerprint
вычисляет Broker и клиент не может прислать его как новое доверенное значение. DTO может не
возвращать `publicKey`, если UI достаточно algorithm/fingerprint.

`revision` и глобальная `vaultGeneration` используются для optimistic concurrency: отставшая
вкладка не должна молча перетереть новый пароль или host key. Изменение host/port увеличивает
`endpointRevision`, инвалидирует незавершённые scans и запрещает connect до нового подтверждения.
Изменение label/tags/username само по себе не переносит trust anchor на другой endpoint.

### Предлагаемые browser API

Все пути ниже существуют только на доверенном SSH-origin и через root-owned gateway. Основной
Cockpit имеет отдельный `POST /api/ssh/launch`, который выпускает лишь одноразовый outer grant и
не проксирует эти API.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/ssh/state` | setup/locked/unlocked и несекретные лимиты |
| `GET` | `/api/ssh/auth/challenge?action=...` | Одноразовый pre-auth challenge |
| `POST` | `/api/ssh/vault/setup` | Создать vault и recovery |
| `POST` | `/api/ssh/vault/unlock` | Step-up unlock |
| `POST` | `/api/ssh/vault/lock` | Заблокировать vault |
| `POST` | `/api/ssh/vault/recover` | Recovery и новый мастер-пароль |
| `POST` | `/api/ssh/vault/password` | Сменить мастер-пароль |
| `POST` | `/api/ssh/auth/logout` | Отозвать только текущую broker-session |
| `GET` | `/api/ssh/servers` | Список после unlock |
| `POST` | `/api/ssh/servers` | Создать запись; секрет write-only |
| `PUT` | `/api/ssh/servers/:id` | Изменить метаданные с revision |
| `POST` | `/api/ssh/servers/:id/password` | Записать/заменить пароль |
| `DELETE` | `/api/ssh/servers/:id/password` | Удалить сохранённый пароль |
| `POST` | `/api/ssh/servers/:id/host-key/scan` | Получить кандидат по клику человека |
| `POST` | `/api/ssh/servers/:id/host-key/confirm` | Закрепить один exact candidate scan |
| `DELETE` | `/api/ssh/servers/:id` | Удалить локальную запись |
| `GET` | `/api/ssh/sessions` | Активные/недавно завершённые сессии |
| `POST` | `/api/ssh/servers/:id/sessions` | Запустить SSH после клика человека |
| `GET` | `/api/ssh/sessions/:id` | Статус и сроки, без вывода |
| `POST` | `/api/ssh/sessions/:id/controller/takeover` | Атомарно забрать controller lease |
| `POST` | `/api/ssh/sessions/:id/extend` | Явно продлить TTL в пределах policy |
| `DELETE` | `/api/ssh/sessions/:id` | Завершить сессию после подтверждения |
| `WS` | `/api/ssh/sessions/:id/terminal` | Attach/input/resize к существующей сессии |

Названия можно уточнить при реализации, но разделение write-only credential API и обычного DTO
обязательно. Каждая мутация несёт ожидаемую `vaultGeneration`/revision через `If-Match` или
эквивалентное типизированное поле; неявного last-write-wins API нет.

## 10. Host key policy

- Единственный источник истины — полный exact public host key в зашифрованной записи vault.
  Отдельный `/var/lib/cockpit-ssh/known_hosts` является только атомарно создаваемым производным
  cache и не резервируется отдельно от vault.
- Результат `ssh-keyscan` хранится server-side в памяти как короткий `scanId`/nonce с TTL и
  привязкой к host, port, `endpointRevision` и набору exact candidate keys.
- UI показывает algorithm и вычисленный Broker-ом SHA-256 fingerprint каждого кандидата. Один
  confirm ссылается только на `scanId` и один `candidateId`; клиент не присылает доверенный raw key
  или fingerprint. Несколько ключей подтверждаются отдельными явными действиями, а не всем
  ответом `ssh-keyscan` сразу.
- Первый exact key всегда показывает UI и подтверждает человек после независимой сверки.
- После commit Broker атомарно пересобирает `known_hosts` из manifest/vault. Crash между commit и
  materialization обнаруживается по generation/digest и приводит к rebuild либо fail closed, но
  не к connect с рассинхронизированным cache.
- Для каждой записи используется внутренний `HostKeyAlias`, производный только от UUID, и точный
  allowlist подтверждённых `HostKeyAlgorithms`; OpenSSH не выбирает неподтверждённый ключ того же
  endpoint.
- В production-запуске стоят `StrictHostKeyChecking=yes` и явный `UserKnownHostsFile`.
- Системный и пользовательский ssh config игнорируются через `-F /dev/null` и фиксированные опции.
- `UpdateHostKeys` не должен незаметно заменить закреплённое значение.
- Ошибка DNS, таймаут, restart Broker, истёкший scan или несколько ключей не должны превращаться в
  автоматическое доверие.
- Изменение host/port инвалидирует закрепление; изменение ключа блокирует вход до нового scan и
  confirm. Backup/restore vault восстанавливает exact keys, после чего cache строится заново.
- Host, port и username валидируются как данные. Значения с NUL, переводом строки, управляющими
  символами, leading dash, `user@host`, URI или пробросом опций отклоняются.

## 11. Запуск OpenSSH без инъекций и утечек

OpenSSH запускается только абсолютным `/usr/bin/ssh` через `spawn`/`execve` с массивом аргументов.
Ни hostname, ни username, ни пароль не попадают в `sh -c`, tmux shell-command или строковую
конкатенацию.

Базовая policy должна зафиксировать как минимум:

```text
-F /dev/null
-o StrictHostKeyChecking=yes
-o UserKnownHostsFile=/var/lib/cockpit-ssh/known_hosts
-o GlobalKnownHostsFile=/dev/null
-o IdentitiesOnly=yes
-o IdentityAgent=none
-o ForwardAgent=no
-o ForwardX11=no
-o ClearAllForwardings=yes
-o PermitLocalCommand=no
-o EscapeChar=none
-o ControlMaster=no
-o UpdateHostKeys=no
-o HostbasedAuthentication=no
-o GSSAPIAuthentication=no
-o NumberOfPasswordPrompts=1
-o LogLevel=ERROR
-o ConnectTimeout=<fixed>
-o ServerAliveInterval=<fixed>
-o ServerAliveCountMax=<fixed>
```

К argv также добавляются внутренний `HostKeyAlias` и exact `HostKeyAlgorithms`, полученные только
из подтверждённой записи. Они не принимаются из произвольного клиентского поля.

Password auth никогда не запускается смешанной fallback-цепочкой:

- `method=password`: `PreferredAuthentications=password`, `PasswordAuthentication=yes`,
  `KbdInteractiveAuthentication=no`, `PubkeyAuthentication=no`;
- `method=keyboard-interactive`: `PreferredAuthentications=keyboard-interactive`,
  `PasswordAuthentication=no`, `KbdInteractiveAuthentication=yes`, `PubkeyAuthentication=no`;
- legacy alias `ChallengeResponseAuthentication` добавляется только если этап 0 докажет, что он
  нужен поддержанному OpenSSH и не расширяет policy;
- для будущего key mode все password/keyboard-interactive методы выключаются.

После отказа выбранного метода Broker завершает попытку. Произвольного поля «Дополнительные SSH
options» в API и UI не будет.

### Передача пароля

- `sshpass` запрещён.
- Пароль не передаётся в argv, env, временный обычный файл или tmux command.
- Root-owned `SSH_ASKPASS` helper получает пароль через одноразовый FIFO/pipe внутри
  `/run/cockpit-ssh/` с `0700/0600` и случайным именем.
- В env находятся только путь к helper и одноразовому каналу, но не пароль.
- `SSH_ASKPASS_REQUIRE=force` и поведение установленного OpenSSH с PTY проверяются на этапе 0.
- Каждый канал связан с session ID, выбранным auth method, конкретным дочерним процессом,
  deadline и single-use capability. Конкурентная сессия не может потребить его ответ.
- В `method=password` секрет выдаётся только первому askpass вызову этого процесса; фиксированный
  auth method, а не текст локализованного prompt, доказывает назначение запроса.
- В `method=keyboard-interactive` первый prompt сначала проходит bounded validation и сравнение
  exact SHA-256 от его UTF-8 bytes с ранее подтверждённым fingerprint. Сохранённый пароль
  автоматически выдаётся только при полном совпадении.
- Первичное закрепление keyboard-interactive prompt требует живого trusted UI: UI безопасно
  показывает escaped prompt, человек явно подтверждает «это запрос того же пароля» и разрешает
  единственную выдачу. Fingerprint сохраняется только после успешной аутентификации и отдельного
  CAS commit.
- Пустой, oversized, malformed или изменившийся prompt не получает сохранённый пароль
  автоматически. UI может предложить одноразовое human-only решение; без живого подтверждения
  попытка завершается по timeout.
- Второй вызов helper, OTP/PIN/смена пароля и другие многошаговые сценарии в MVP никогда не
  получают тот же secret: канал закрывается, попытка завершается как unsupported. MFA можно
  добавить позже отдельным human-only протоколом.
- После первой выдачи или любого cancel/error канал закрывается и удаляется; повторный вызов
  получает отказ без секрета.
- Пароли с NUL/CR/LF отклоняются из-за несовместимости с askpass-протоколом; пробелы, Unicode и
  shell-метасимволы остаются обычными символами пароля.
- Ошибка helper не печатает секрет и не включает debug-логирование OpenSSH.

## 12. Живые сессии

Broker владеет PTY и отдельным tmux socket в `/run/cockpit-ssh/`. На один SSH-сеанс создаётся
отдельная tmux-сессия со строгим внутренним UUID. Remote host и другие пользовательские строки
никогда не интерполируются в команду tmux; внутри запускается root-owned session launcher,
который получает уже проверенную структуру.

Session registry задаёт явные состояния `starting → authenticating → connected → exited →
terminated`; обратного перехода к `starting` нет. Viewer attach имеет собственный случайный ID и
server-bound WebSocket. Controller lease хранит `{sessionId, socketId, browserSessionId, epoch,
expiresAt}`; `epoch` монотонно растёт и не выбирается клиентом.

Поведение:

- закрытие WebSocket завершает только viewer/attach, но не SSH;
- повторное открытие маршрута подключает браузер к тому же session ID;
- основной Cockpit можно перезапустить, SSH и tmux продолжат жить в отдельном system service;
- browser WebSocket может автоматически восстановить attach к **уже живой** сессии;
- если сам SSH завершился, Broker не запускает его заново без нового клика «Подключиться»;
- одновременный ввод разрешён только одному controller; второй экран открывается read-only и может
  забрать управление отдельной кнопкой;
- takeover выполняется под mutex session registry: Broker сначала увеличивает controller epoch,
  затем демотирует/закрывает старый socket и только после этого подтверждает новый lease;
- input и resize маркируются текущим server-side epoch при приёме и повторно проверяются
  непосредственно перед записью в PTY. Задержанные/буферизированные frames старого controller,
  включая `Enter`, после takeover, lock или expiry отбрасываются;
- два одновременных takeover не могут оба получить один epoch; клиентский sequence number
  используется только для дедупликации и не заменяет server-side fencing;
- resize передаётся tmux с жёсткими пределами cols/rows;
- scrollback имеет лимит и живёт только в памяти/tmux, не в audit и не на диске;
- завершение сессии удаляет scrollback и runtime-файлы;
- manual/automatic vault lock, broker-auth expiry, recovery и outer-session revocation закрывают
  viewer WS и controller lease, но оставляют SSH detached;
- перезапуск Broker завершает все SSH-сеансы и явно показывается как отдельный риск.

Lifecycle процесса закрепляется unit-контрактом: SSH, launcher и tmux остаются в cgroup Broker;
`KillMode=control-group`, bounded `TimeoutStopSec`, `SendSIGKILL=yes` и
`RuntimeDirectoryPreserve=no` обязательны. Tmux нельзя переносить в другой scope или daemon cgroup.
После normal stop, crash, SIGKILL, OOM/restart и reboot не остаётся attachable tmux, SSH PID или
socket. Новый Broker никогда не усыновляет старую сессию: stale runtime/process обнаруживается до
listen и приводит к fail closed/явной root-cleanup процедуре.

Начальные лимиты:

- максимум 6 параллельных SSH-сессий;
- до 10 000 строк scrollback на сессию;
- detached TTL 2 часа;
- absolute TTL 24 часа;
- предупреждение в UI перед окончанием TTL и отдельная человеческая кнопка продления в пределах
  policy.

Точные значения должны быть конфигом Broker, но бесконечных сессий и безлимитного scrollback не
будет.

## 13. Планшетный интерфейс

Оба маршрута обслуживает только root-owned bundle на отдельном SSH-origin. В основном Cockpit
остаётся top-level ссылка/launch flow; компонентов SSH, iframe и terminal proxy в обычном web
bundle нет. SSH UI ставит строгий CSP (`frame-ancestors 'none'`, bounded `connect-src`), не
регистрирует service worker и не разрешает CORS обычному Cockpit-origin для Broker API.

### `/ssh`

- крупные карточки серверов с названием, тегами, состоянием fingerprint и типом авторизации;
- основной tap-target «Подключиться»;
- фильтр/поиск без отправки данных на сервер на каждый символ;
- отдельный блок активных сессий с возрастом, attach-state и оставшимся TTL;
- состояния vault: setup, locked, unlocking, unlocked, recovery;
- write-only формы без автосохранения в prefs, Pinia persistence, local/session storage;
- пароль очищается из Vue state и DOM после success/error/unmount;
- recovery-код и auth responses не попадают в browser cache, Cache API, telemetry или crash
  reporting;
- destructive действия требуют подтверждения и не прячутся в случайный swipe.

### `/ssh/session/:id`

- xterm занимает основную высоту и получает корректный resize при повороте планшета;
- верхняя панель показывает сервер, состояние SSH, attach и TTL;
- reconnect к viewer отличается от нового remote connect;
- чат сворачивается в drawer снизу или сбоку в зависимости от ширины;
- обмен с обычным chat backend идёт через отдельный ограниченный cross-origin контракт без
  broker-cookie/CSRF/session ID; ответы чата всегда считаются недоверенным инертным текстом;
- системная клавиатура, Ctrl/Esc/Tab и экранные служебные клавиши не должны закрывать чат или
  сдвигать терминал за viewport;
- browser wake lock может запрашиваться только после действия человека и не считается способом
  удерживать SSH: сессия и без него живёт в Broker.

Визуальную тему и xterm-настройки можно перенести из `TerminalView.vue` на этапе сборки доверенного
bundle, но runtime-импорт из изменяемого обычного web bundle запрещён. Lifecycle текущего
`/terminal` копировать нельзя: там дочерний процесс завершается вместе с WebSocket.

## 14. Чат внутри SSH-экрана

### Контекст модели

По умолчанию чат получает только:

- факт, что открыт SSH-раздел;
- отображаемое название сервера и безопасные теги;
- просьбу отвечать объяснением и карточками команд;
- явное указание, что выполнить, вставить или прочитать терминал он не может.

Hostname, username и прочие метаданные добавляются только если продуктово понадобятся и человек
это явно разрешит. Учётные данные, host key, session token и terminal stream не входят в chat
context никогда.

### Карточка команды

1. Агент возвращает текст команды.
2. UI показывает точный предварительный просмотр.
3. Человек нажимает «Вставить».
4. Клиент удаляет C0/C1, NUL, CR/LF, ANSI/OSC, DEL и невидимые bidi-control символы.
5. Если очистка изменила команду, UI показывает итог ещё раз; многострочная команда не вставляется
   как одна строка молча.
6. В терминал отправляется только очищенный текст без добавленного `Enter`, `;` или пробела.
7. Человек проверяет строку и сам нажимает `Enter`.

Кнопка «Вставить» существует только в браузерном компоненте. Сервер чата не получает endpoint
ввода, а Broker не принимает командные карточки от backend.

### Отправка вывода агенту

1. Человек выделяет фрагмент в xterm и нажимает «Спросить об этом».
2. Сырое выделение остаётся в памяти браузера.
3. Локальный redactor маскирует распространённые токены, пароли, приватные ключи, cookie и URL с
   credentials.
4. UI показывает именно тот текст, который уйдёт модели, и предупреждает, что автомаскирование не
   гарантирует нахождение всех секретов.
5. Только после отдельного подтверждения очищенный текст добавляется в обычное сообщение чата.

Автоматической отправки последних строк, ошибок, prompt, текущего экрана или scrollback не будет.

## 15. Дополнительные способы авторизации

Они реализуются после приёмки password-first MVP на той же модели данных и UI:

### Импорт существующего ключа

- приватный ключ и passphrase — write-only;
- API возвращает только тип, public fingerprint и дату обновления;
- ключ проверяется и нормализуется внутри Broker;
- приватный материал шифруется vault DEK и не пишется в `~/.ssh`.

### Уникальный Ed25519-ключ на сервер

- Broker генерирует отдельную пару для одной записи сервера;
- UI показывает только public key и fingerprint для ручного добавления на сервер;
- до подтверждения человеком запись имеет состояние `not_authorized`;
- удаление локального ключа показывает процедуру удаления соответствующего fingerprint из
  удалённого `authorized_keys`;
- Cockpit не утверждает, что удалил удалённый ключ автоматически.

Ни один из этих режимов не меняет парольные серверы автоматически и не превращается в
обязательную рекомендацию при каждом входе.

## 16. Изоляция процессов агентов

До production-релиза нужно:

- удалять из env каждого executor-а `SSH_AUTH_SOCK`, `SSH_AGENT_PID` и переменные, указывающие на
  SSH credentials;
- запускать агентов с пустым, недоступным им представлением `~/.ssh`, сохранив только явно нужные
  provider-specific каталоги;
- закрыть для агентских mount namespace `/var/lib/cockpit-ssh`, `/run/cockpit-ssh` и production
  каталоги Broker;
- скрыть через namespace/`/proc` policy процессы, `environ`, fd и memory Broker/gateway; агент и
  основной пользователь не могут `ptrace`, signal, restart или читать process state этих service
  users;
- не добавлять `cockpit-ssh` в общие группы и не давать основному пользователю доступ к tmux socket;
- не давать агентам write к root-owned gateway/UI/bootstrap, TLS key SSH-origin, release signing
  key и installed release; изменение checkout с restart обычного Cockpit ничего из этого не
  заменяет;
- проверить отдельно Claude, Codex и каждый будущий executor, а не считать общий env-hook
  достаточным доказательством;
- провести человеческую инвентаризацию ранее установленных публичных ключей и отозвать ненужные
  на целевых серверах.

Простая подмена `HOME` может сломать OAuth/config самих CLI и не считается готовой изоляцией.
Нужен воспроизводимый launcher с mount namespace/allowlist bind mounts и контрактные тесты.
Отдельно проверяются чтение `/proc/<pid>/{environ,fd,mem}`, `process_vm_readv`, signal и попытка
перезапустить system units: одного отказа `curl :8151` недостаточно.

Даже после этого агент с общим доступом в интернет теоретически может открыть произвольный TCP
socket. Гарантия этого проекта уже и проверяема: он не может использовать Broker, сохранённый
пароль, ключ, broker-cookie, attach-сессию или старый `~/.ssh` для самостоятельного
аутентифицированного входа. Обычный Cockpit также не является транспортом SSH-трафика и не может
получить session capability простым добавлением proxy-маршрута в checkout.

## 17. Установка и systemd hardening

Структура в репозитории:

```text
ssh-broker/                    # исходники и package lock отдельного сервиса
ssh-gateway/                   # trusted ingress, SSH-origin и streaming gateway
ssh-web/                       # отдельный доверенный bundle /ssh
deploy/ssh/build-release.sh    # только непривилегированная сборка artifact
deploy/ssh/bootstrap/          # исходник bootstrap для packaging/review, не sudo-entrypoint
deploy/ssh/*.service           # systemd units
server/src/modules/ssh-launch/ # только одноразовый outer launch grant, без Broker proxy
web/src/                       # только внешняя ссылка/индикатор SSH-раздела
tests/ssh/                     # unit/integration/security fixtures
```

### Доверенная release-цепочка

Любой `sudo ./...` из изменяемого checkout запрещён. В частности, production-инструкция никогда
не предлагает `sudo ./deploy/ssh/install.sh`: агент может изменить такой файл до следующего
ручного update и получить выполнение своего кода от root.

Контракт поставки:

1. Broker, gateway и SSH UI собираются **непривилегированно** в одноразовом каталоге из lockfile.
   Package lifecycle hooks по умолчанию выключены; необходимое исключение требует отдельного
   allowlist и review.
2. Результат — data-only release artifact с version, source commit, manifest всех файлов/mode и
   digest. В нём запрещены absolute/`..` paths, symlink/hardlink/device nodes, setuid bits и
   post-install scripts.
3. Artifact получает detached signature release-ключом, недоступным основному пользователю,
   checkout и агентам. Human approval показывает diff/source commit и точный artifact digest до
   подписи; один hash без независимого trusted signer не считается проверкой происхождения.
4. Root-owned `/usr/local/sbin/cockpit-ssh-install` уже содержит pinned verification key. Он
   сначала копирует artifact через `O_NOFOLLOW` в root-owned staging, проверяет подпись над теми же
   bytes и manifest, а затем только копирует данные и ставит unit/config. Он не запускает код,
   `npm`, build hooks или произвольные команды из artifact от root.
   Обычный application artifact не может обновить сам bootstrap или pinned key: для них нужен
   отдельный bootstrap package/signing path.
5. Первый bootstrap устанавливается только из подписанного OS package или другого read-only
   trusted medium с out-of-band fingerprint. До появления такого bootstrap production install
   считается заблокированным; копирование и запуск bootstrap из writable checkout не является
   временным допустимым решением.
6. Dev-mode может запускать непривилегированную сборку с throwaway state/test credentials, но не
   называется production и не читает `/var/lib/cockpit-ssh`.

После реализации рабочий production flow имеет форму:

```bash
./deploy/ssh/build-release.sh --output <artifact>   # без sudo; либо скачать подписанный release
/usr/local/sbin/cockpit-ssh-install --verify-only <artifact> <signature>
sudo /usr/local/sbin/cockpit-ssh-install --install <artifact> <signature>
./deploy/install.sh                                 # обычная ссылка/launch endpoint Cockpit
bin/restart
```

Локально собранный artifact нельзя установить в production, пока его не проверил и не подписал
независимый release signer. Точные bootstrap/package команды документируются только после
реализации этой цепочки.

### Действия root installer

После проверки artifact установщик должен:

1. Проверить поддержанные Node.js, `/usr/bin/ssh`, `ssh-keyscan`, `ssh-keygen`, tmux, `script`/
   выбранный PTY backend и systemd.
2. Создать locked system users `cockpit-ssh` и `cockpit-ssh-web` без пароля, login-shell, `sudo`,
   дополнительных или общих групп.
3. Атомарно установить root-owned release в versioned `/opt/cockpit-ssh-*` и переключить только
   после полной проверки; installed code не writable service users.
4. Создать `/var/lib/cockpit-ssh` и `/run/cockpit-ssh` с правильными владельцем/mode, а TLS key и
   ingress config SSH-origin — в отдельном root-owned каталоге, недоступном основному пользователю.
5. Установить Broker unit с `User=cockpit-ssh`, `Group=cockpit-ssh`, `UMask=0077`,
   `NoNewPrivileges=yes`, пустым capability bounding set, `ProtectSystem=strict`, `ProtectHome=yes`,
   `PrivateTmp=yes`, `PrivateDevices=yes`, `KillMode=control-group`, `SendSIGKILL=yes`,
   `OOMPolicy=stop`, `LimitCORE=0`, bounded `TimeoutStopSec`, `RuntimeDirectoryMode=0700`,
   `RuntimeDirectoryPreserve=no` и syscall/namespace policy, прошедшей реальные тесты
   Node/OpenSSH/tmux.
6. Установить gateway unit с `User=cockpit-ssh-web`, без доступа к state/runtime Broker, с тем же
   filesystem/process hardening и только необходимыми network/TLS reads.
7. Разрешить Broker запись только в state/runtime и исходящие SSH-соединения. Зафиксировать bind
   строго на `127.0.0.1:8151`; проверить отсутствие `0.0.0.0`, IPv6 wildcard и иных listener.
8. Настроить root-owned gateway на существующем HTTPS-порту: exact SNI/`Host` обычного origin идёт
   к loopback Cockpit, exact SSH-origin — к trusted bundle/Broker. Неизвестный host отклоняется;
   дополнительный внешний порт не создаётся.
   Прямой network HTTPS listener основного Cockpit в этом режиме выключается; попытка обоих
   процессов занять порт или обойти gateway приводит к fail closed.
   Внешний ingress для SSH-origin проверяется как TLS passthrough либо отдельный trusted component;
   HTTP-терминация в обычном application proxy не допускается.
9. Проверить отдельный TLS trust/key SSH-origin, health, CSP/origin policy и отказ запроса с
   Cockpit internal token. User-owned CA/signing key не допускается как скрытый обход границы.
10. Не расшифровывать, не печатать, не передавать gateway и не включать vault в crash/reporting
    во время install/update.

### Update без TOCTOU

Root updater сначала полностью проверяет новый artifact, затем атомарно переводит Broker в
`draining`. Конкретный control protocol не использует browser/internal token: root посылает unit
фиксированный maintenance signal, а Broker под тем же mutex, что создаёт session registry,
запрещает новые remote connects и пишет свежий ack с boot/process ID и generation в защищённый
runtime. Updater проверяет свежесть ack; stale или timeout означает abort.

После `draining=true` считаются все `starting`, `authenticating`, `connected` и `terminating`
сессии, сверяются registry, tmux socket и cgroup. Если они есть, обычный update показывает число,
атомарно снимает draining и ничего не переключает. Если их нет, Broker остаётся draining до
завершения install/restart, поэтому connect не может попасть между check и stop. Падение updater
оставляет fail-safe draining с явной root-командой resume.

Принудительный вариант имеет отдельное имя, требует точного подтверждения и явно завершает
соединения. Агент никогда не может signal/restart units или запустить root updater из чата.

Uninstall сохраняет `/var/lib/cockpit-ssh` по умолчанию. Уничтожение vault, `known_hosts` и audit
доступно только отдельным `--purge` с повторным явным подтверждением точного пути.

## 18. Этапы реализации

### Этап 0 — локальный контрактный spike

- [ ] Проверить фактическое поведение установленного OpenSSH с PTY/tmux,
  `SSH_ASKPASS_REQUIRE=force`, строго отдельными `password` и `keyboard-interactive` methods и
  `NumberOfPasswordPrompts=1`.
- [ ] На fake sshd пройти success и негативную матрицу: password; один подтверждённый prompt;
  OTP/PIN-first; второй prompt; пустой, oversized, malformed, динамический и локализованный prompt;
  helper repeat; cancel; timeout; crash; две конкурентные попытки.
- [ ] Доказать exact prompt pinning для одношагового keyboard-interactive. Если это невозможно на
  поддержанном OpenSSH, этот method блокирует релиз заявленной функции и не подменяется эвристикой
  текста или автоматической отправкой первого секрета.
- [ ] Доказать одноразовую передачу пароля через FIFO/pipe без появления в `ps`,
  `/proc/*/cmdline`, env, tmux history, journald, core dump и логах приложения.
- [ ] Проверить attach/detach, resize, bounded scrollback и прототип controller fencing: два
  takeover, задержанный frame/`Enter`, lock/expiry во время input.
- [ ] Проверить уничтожение tmux/SSH/runtime после normal stop, crash, SIGKILL, OOM/restart и
  reboot с `KillMode=control-group`; stale state не усыновляется новым Broker.
- [ ] Подтвердить отдельный SSH-origin на том же внешнем HTTPS-порту, недоступность его cookie/UI
  обычному Cockpit-origin и root-owned TLS trust chain. Same-origin fallback запрещён.
- [ ] Сформировать минимальный signed artifact и доказать, что root installer не выполняет
  checkout-код, package hooks или artifact scripts.
- [ ] Зафиксировать поддержанный минимум версий Node/OpenSSH/tmux.
- [ ] Проверить hardening unit через `systemd-analyze security` и реальные подключения.
- [ ] Зафиксировать многошаговый MFA как unsupported в MVP либо отдельный human-only протокол без
  повторной автоматической выдачи сохранённого пароля.

Результат этапа — воспроизводимый fake-server/gateway/systemd fixture и короткий протокол с
доказательствами. Этап 0 можно начинать до остальных правок кода; production package не начинается
до успешного обычного password, безопасного одношагового keyboard-interactive, отдельного origin и
cgroup lifecycle.

### Этап 1 — trusted release, gateway и units

- [ ] Реализовать непривилегированную reproducible build и подписанный data-only artifact.
- [ ] Поставить bootstrap installer из независимого trusted medium; запретить sudo-entrypoint из
  checkout и проверить archive traversal/symlink/hook negative cases.
- [ ] Создать root-owned `ssh-gateway`, trusted SSH UI skeleton, отдельные users и hardening units.
- [ ] Перенести production network HTTPS на exact-host gateway без дополнительного внешнего порта;
  сделать TLS key/signing capability SSH-origin недоступными агентам.
- [ ] Реализовать install/update/uninstall, cgroup cleanup и maintenance drain/ack/resume без
  TOCTOU.
- [ ] Доказать, что изменение checkout и restart основного Cockpit не меняют installed gateway/UI.

### Этап 2 — Broker, vault и browser-auth

- [ ] Создать отдельный package `ssh-broker/` без импортов server Cockpit.
- [ ] Реализовать manifest vault, writer queue/lock, generation/CAS и atomic whole transaction.
- [ ] Реализовать setup/unlock/lock/change/recovery с одноразовой ротацией recovery-кода,
  `authEpoch`/auth instance и no-store response policy.
- [ ] Добавить outer-session binding, pre-auth challenges, независимые browser sessions, rate limit,
  CSRF и exact Origin policy только на HTTPS SSH-origin.
- [ ] Добавить безопасный audit, interrupted-write recovery и explicit whole-vault restore policy.
- [ ] Поднять loopback health и доказать, что internal/CLI/ordinary Cockpit tokens не дают доступ.

### Этап 3 — password-first серверы

- [ ] Реализовать CRUD записи, global generation/revision CAS и write-only password endpoints.
- [ ] Сделать `method=password` дефолтом и запретить смешанную auth fallback policy.
- [ ] Реализовать nonce-bound scan и confirm одного exact public host key; materialized
  `known_hosts`, внутренний alias и algorithm allowlist.
- [ ] Собрать фиксированный argv OpenSSH и негативные тесты injection.
- [ ] Реализовать process-bound одноразовый askpass channel и очистку секретов.
- [ ] Покрыть обычный password и закреплённый одношаговый keyboard-interactive, включая mismatch и
  второй prompt без автоматической выдачи.

### Этап 4 — живые SSH-сессии

- [ ] Реализовать session launcher, PTY/tmux ownership и однонаправленную remote state machine.
- [ ] Разделить remote connect, viewer attach и controller lease с монотонным fencing epoch.
- [ ] Реализовать WebSocket terminal, resize, bounded scrollback и backpressure; старые frames
  повторно проверяются перед PTY write.
- [ ] Добавить detached/absolute TTL, лимит сессий, explicit extend и ручное завершение.
- [ ] Сохранить сессии при restart основного Cockpit и гарантированно завершить весь cgroup при
  restart/crash Broker.
- [ ] Запретить автоматический remote reconnect после выхода SSH.

### Этап 5 — trusted tablet UI и launch

- [ ] Реализовать one-time launch grant в основном Cockpit без HTTP/WSS Broker proxy.
- [ ] Добавить `/ssh` и `/ssh/session/:id` в отдельный root-owned bundle, а в обычный UI — только
  external top-level link и route guard.
- [ ] Реализовать setup/unlock/recovery, password CRUD и exact host-key confirmation.
- [ ] Реализовать карточки, фильтр, active sessions и tablet layouts.
- [ ] Перенести xterm visual layer без runtime-зависимости от обычного bundle/lifecycle Terminal.
- [ ] Очистить secret state на success/error/unmount; исключить persistence, service worker/cache,
  iframe и широкие CORS/connect-src.

### Этап 6 — чат с ручной границей

- [ ] Встроить обычный чат без проекта, Broker tool и передачи Broker credentials.
- [ ] Добавить inert command cards и локальный sanitizer.
- [ ] Доказать, что insertion не добавляет `Enter` и вызывается только реальным browser click.
- [ ] Добавить xterm selection → local redaction preview → explicit confirm → cross-origin chat
  message без session capability.
- [ ] Проверить, что raw terminal output отсутствует во всех model requests и telemetry.

### Этап 7 — изоляция агентов

- [ ] Удалить SSH agent env и внедрить проверяемое сокрытие `~/.ssh` для всех executors.
- [ ] Проверить прямой запрос агента к `:8151`, SSH-origin API, runtime/vault и `/proc` service
  users; проверить ptrace/signal/restart и чтение fd/env/memory.
- [ ] Доказать, что изменённые proxy/UI/installer в checkout и restart Cockpit не меняют trusted
  release и не дают terminal capability.
- [ ] Провести отзыв/перенос старых ключей на реальных серверах вручную.

### Этап 8 — эксплуатация и password-first выпуск

- [ ] Добавить backup/restore зашифрованного vault без расшифровки installer-ом.
- [ ] Проверить одноразовый recovery, explicit rollback semantics и отзыв auth после restore.
- [ ] Добавить draining, предупреждение и атомарную блокировку update при active/starting session.
- [ ] Провести security checklist и tablet E2E.
- [ ] Документировать install/update/uninstall/recovery/host-key-change/password-rotation.
- [ ] Выпустить сначала на одном тестовом парольном сервере, затем на остальных.

### Этап 9 — дополнительные auth modes после MVP

- [ ] Только после приёмки password-first MVP добавить импорт ключа/passphrase как write-only.
- [ ] Добавить опциональную генерацию отдельного Ed25519-ключа на сервер.
- [ ] Добавить процедуру ручного отзыва remote `authorized_keys`.
- [ ] Повторить threat-model и утечечные тесты для key material; password servers не мигрировать.

## 19. Проверки

### Unit и property tests

- vault: wrong password, tamper, nonce uniqueness, version migration и atomic write;
- vault transaction: writer serialization, generation/revision CAS, parallel mutation, manifest
  mismatch и подмена объекта старым valid ciphertext;
- recovery: старый код не работает после success, новый wrapper/master коммитятся вместе,
  auth instance/epoch меняются;
- DTO: ни один list/detail/error не содержит password/private key/passphrase;
- validation: host/user/port/tag limits, Unicode, NUL, CR/LF, leading dash, option injection;
- argv snapshot: только allowlist и ни одного shell string;
- host key: fingerprint вычисляется из exact key, scan binding нельзя перенести на другой
  host/port/revision, один confirm не принимает весь candidate set;
- askpass state machine: method binding, exact prompt hash, single-use/cancel/timeout/repeat и
  изоляция конкурентных capability;
- controller state: монотонный epoch, delayed frame после takeover/lock/expiry отбрасывается;
- audit redaction: секрет, команда и terminal bytes не попадают даже в error path;
- sanitizer карточек: CR/LF, ANSI/OSC, bracketed paste, bidi controls и oversized input;
- redactor: известные форматы токенов с обязательным preview.

### Integration tests

- internalToken, cliToken и обычная Cockpit cookie не открывают Broker API;
- main Cockpit не находится в HTTP/WSS пути SSH-origin; его изменённый proxy/UI и restart не
  меняют installed trusted bundle и не видят broker-cookie/terminal frames;
- launch grant имеет fixed audience/redirect, одноразов, истекает и создаёт только outer-session;
- pre-auth challenge нельзя replay, перенести на другой action/tab/outer-session или использовать
  после auth epoch change;
- stolen/expired CSRF, неверный exact Origin, HTTP downgrade, чужая outer-session и
  неавторизованный WS отклоняются;
- logout/logout-all/password change/user switch обычного Cockpit отзывают связанную Broker-сессию;
- recovery атомарно ротирует код; старые recovery, cookie, CSRF, controller lease и уже открытый
  WS после commit не работают, а SSH остаётся detached;
- конкурентные setup/recover/password/CRUD не теряют commit и дают deterministic `409`;
- password и закреплённый single-prompt keyboard-interactive проходят через fake/local sshd;
- OTP/PIN-first, второй, пустой, oversized, localized/dynamic prompt, helper repeat/cancel/crash и
  конкурентные подключения не получают сохранённый пароль автоматически;
- пароль отсутствует в argv/env/journal/audit/API после success и failure;
- первый exact host key требует confirm, multi-key scan не подтверждается целиком, changed key
  всегда блокирует connect;
- crash на каждой границе vault commit/`known_hosts` materialization приводит к rebuild или
  fail closed; OpenSSH не принимает key, которого нет в canonical manifest;
- закрытие WS не убивает SSH, повторный attach получает ту же сессию;
- одновременные takeover и задержанные input/resize frames проверяют server-side fencing;
- lock/auth expiry/recovery закрывают attach и запрещают buffered `Enter`, но не убивают SSH;
- restart Cockpit сохраняет SSH; normal stop, crash, SIGKILL, OOM/restart и reboot Broker не
  оставляют SSH/tmux PID, socket или attachable session;
- startup со stale runtime/process fail closed и не усыновляет старую tmux-сессию;
- выход SSH не вызывает автоматический новый connect;
- connect против update проверяется как race: после drain ack новый `starting` невозможен; обычный
  update отказывается при active/starting session и корректно resume-ит Broker;
- подписанный installer отклоняет bad signature, изменённые bytes, traversal, symlink/hardlink,
  device/setuid и script/hook artifact; root не исполняет checkout или package code;
- SSH-origin TLS key/signing capability недоступны основному пользователю, service worker Cockpit
  не контролирует его scope, recovery/auth responses имеют no-store;
- внешний ingress сохраняет end-to-end trusted SSH-origin: L4 passthrough либо проверенный trusted
  terminator; обычный HTTP proxy не видит cookie/body/terminal frames;
- лимиты frames/input/backpressure/scrollback не позволяют съесть память Broker.

### Agent-boundary tests

- агент не видит `SSH_AUTH_SOCK`, `~/.ssh`, vault, runtime socket и tmux socket;
- прямой `curl 127.0.0.1:8151` без broker-cookie бесполезен;
- агент не читает `/proc`/fd/env/memory Broker/gateway, не ptrace/signal/restart их и не получает
  TLS/release signing key;
- изменение `ssh-broker/`, `ssh-gateway/`, `ssh-web/`, обычного proxy или installer source в
  checkout с restart Cockpit не меняет root-owned production release;
- ordinary Cockpit-origin не может fetch/embed Broker API или прочитать SSH-origin response из-за
  host-only cookie, SOP, CORS и CSP;
- сообщение агента с командой, HTML, JavaScript, ANSI и переводом строки ничего не выполняет;
- без browser click Broker не получает terminal input event;
- после клика приходит строка без Enter;
- terminal output не появляется в model request до selection/redaction/confirm;
- обычные ключи, ранее разрешённые на тестовом сервере, отозваны либо недоступны executor-у.

## 20. Критерии готовности password-first MVP

MVP готов только если одновременно выполнено следующее:

- production открывает `/ssh` на отдельном trusted origin через root-owned gateway; основной
  Cockpit не проксирует HTTP/WSS и не может заменить установленный SSH UI своим restart;
- release установлен root-owned verifier-ом из подписанного artifact без выполнения checkout/
  package code от root; TLS/signing capability SSH-origin недоступны агентам;
- с планшета можно добавить сервер, сохранить пароль, сверить fingerprint и подключиться;
- парольный режим выбран по умолчанию и не требует наличия SSH-ключа;
- обычный `password` и закреплённый одношаговый `keyboard-interactive` работают как отдельные
  methods; неизвестный/второй prompt не получает сохранённый пароль автоматически;
- пароль ни при успехе, ни при ошибке не обнаруживается в API, логах, argv, env и browser storage;
- vault mutations сериализованы и CAS-защищены; параллельные операции не теряют изменения, old
  valid ciphertext нельзя незаметно подставить в текущий manifest;
- ровно подтверждённый exact host key является canonical anchor; смена key или endpoint
  гарантированно блокирует вход;
- сон планшета и разрыв WebSocket не завершают работающий SSH;
- перезапуск основного Cockpit не завершает SSH;
- takeover/lock/expiry имеют controller fencing и не пропускают задержанный ввод старого viewer;
- stop/crash/SIGKILL/OOM/restart Broker не оставляет SSH/tmux/socket и не усыновляет stale runtime;
- новый удалённый вход и повторный вход после обрыва происходят только после клика человека;
- агент не может получить broker-auth, открыть сохранённое соединение, читать терминал или ввести
  команду;
- карточка команды вставляет только просмотренный текст и никогда не отправляет Enter;
- вывод уходит модели только после локального preview и отдельного подтверждения;
- update Broker сначала входит в draining и атомарно блокирует гонку нового connect; при активной
  или starting-сессии обычный update ничего не переключает;
- recovery-код открывает тестовую копию vault, атомарно выдаёт новый одноразовый код и отзывает
  старые cookie/CSRF/controller/WS; неверный или старый код ничего не повреждает.

## 21. Порядок безопасного rollout

1. Реализовать и проверить этап 0 на локальных одноразовых sshd/gateway/systemd fixtures без
   production credentials.
2. Установить независимо проверенный bootstrap и тестовый подписанный artifact; доказать
   отдельный SSH-origin, TLS ownership и неизменность trusted bundle после restart Cockpit.
3. Создать тестовый vault и пройти concurrent mutation, recovery rotation, auth revocation,
   whole-snapshot restore/rollback warning и cache materialization без production credentials.
4. Подключить один специально созданный парольный test account с минимальными правами и отдельно
   проверить `password`/закреплённый single-prompt `keyboard-interactive`.
5. Пройти утечки, exact host-key change/multi-key scan, controller races, reconnect,
   crash/cgroup cleanup, update drain race и agent-boundary проверки.
6. Отдельно проверить backup/recovery на копии данных и убедиться, что restore создаёт новый auth
   instance и отзывает все старые browser capabilities.
7. Добавить первый реальный парольный сервер.
8. Только после полной password-first приёмки переходить к импорту и генерации ключей.

Откат обычного Cockpit UI меняет только ссылку и не откатывает trusted SSH release. Откат gateway/
Broker выполняется тем же подписанным updater и тем же drain protocol, не удаляя vault. Остановка
Broker завершает его активные SSH-сессии, но зашифрованные данные остаются. Полное уничтожение
данных выполняется только явным purge.
