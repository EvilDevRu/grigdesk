# KimiRuntime: security gate

Текущий основной режим запуска Kimi-чатов — **host** (`kimiLaunchMode=host`,
умолчание): прямой дочерний процесс сервера `kimi acp`, parity с claude. Contained-профиль
`kimi-contained-v1` сохранён и включается откатом `COCKPIT_KIMI_LAUNCH_MODE=contained`;
всё описанное ниже относится к contained и по-прежнему действует при откате.

## Host-режим (умолчание)

`server/src/lib/kimi/host-launch.js` строит запуск `kimi acp` прямым spawn-ом сервера с
`KIMI_CODE_HOME = config.kimiHome` (реальный `~/.kimi-code`) и caller-env chat-модуля —
тем же, что получает claude. Мотивация: contained-профиль не давал read-доступа к
диагностике движка (`~/.factory/**`), что блокировало разборы инцидентов из чата.

Настройка исполнителя `blockDirectSsh` по умолчанию включена. Host не имеет отдельного
сетевого или командного рубежа, который честно удержал бы её во всех ACP-режимах, поэтому
здесь выбран `fail-closed`: ход отклоняется кодом `direct_ssh_policy_unavailable` до
preflight, сборки launch и spawn. Запустить host-ход можно только после подтверждённого
сохранения `false` либо переключением на contained.

Contained сохраняет прежний network invariant независимо от тумблера: даже при явно
сохранённом `blockDirectSsh: false` отдельная сеть и egress allowlist пропускают только API
Kimi. Выключение не расширяет contained-сеть; оно важно при будущей смене режима на host.

Что осознанно отключается относительно contained:

- mount/pid/net namespace изоляция и маски control state: процесс видит host FS целиком,
  включая `~/.factory`, `server/.state`, токены окружения сервера (как claude);
- egress allowlist: сеть прямая (как у claude/codex);
- cgroup-лимиты (CPU/memory/RuntimeMaxSec): остаётся chat watchdog модуля;
- per-chat KIMI_CODE_HOME и broker config: host config/skills/plugins/hooks/MCP
  наследуются (parity с claude `~/.claude`);
- жёсткий pin версии: расхождение — предупреждение в лог (host CLI обновляет
  пользователь). ACP `protocolVersion === 1` остаётся обязательным;
- staging вложений: файлы читаются по исходным путям (корень `chats/attachments`
  по-прежнему проверяется);
- `extraDirs` (prefs.trustedDirectories): у `kimi acp` нет `--add-dir`, у ACP нет
  additionalDirs — pre-authorization невозможен. Доступ за пределами cwd закрывает
  permission-система Kimi (промпты; в cockpit-режиме «Авто» — auto-approve.js).
  Проектный `.kimi-code/local.toml` читается нативно.

Что остаётся: ACP contract (initialize/session/resume/prompt/cancel), режимы
`default`/`plan`/`yolo` (см. «Режимы прав» ниже), permission reverse RPC с
всплывашкой в UI, политика «Авто» поверх, CAS session bindings — с новым profile id
`kimi-host-v1`: contained bindings несовместимы и ротируются одноразово при переключении
(contained-сессии жили в per-chat runtime home, host-процессу недоступном). Проверка
credentials (`0600`, владелец) и исполняемости бинаря — та же, что в contained.

Покрытие: `tests/server/kimi-host-launch.test.js` (launch contract) и host-кейсы в
`tests/server/kimi-runtime.test.js` (прямой spawn без proxy/preflight/systemd, ACP-ход,
корень вложений).

## Contained-профиль (откат)

Contained-профиль `kimi-contained-v1` был допущен для закреплённой версии Kimi Code `0.31.1`.

Это узкое разрешение на запуск Kimi из чатов через единственный contained runtime. Оно не
разрешает прямой spawn CLI, наследование host environment, автоматические permissions или запуск
другой версии без повторного аудита и preflight.

## Обязательный host preflight

Preflight повторяется на каждой машине; его результаты не являются частью общей поставки.
Успех означает все условия сразу:

- Linux namespaces действительно создаются через Bubblewrap;
- transient user-systemd service применяет CPU, memory, swap и process limits, а
  `KillMode=control-group` убивает всё дерево;
- versioned egress policy доступна только через private Unix socket;
- credentials монтируются rw на весь запуск; transient unmount barrier снят — см. ниже.

Прямая делегация writable cgroup subtree сервису всё ещё недоступна. Runtime не ослабляет gate:
он использует проверенную альтернативу через transient user-systemd service и перед каждым
запуском сверяет реально применённые свойства unit. Process group сама по себе заменой cgroup не
считается.

## Границы contained runtime

- [sandbox builder](../../server/src/lib/kimi/sandbox.js) создаёт пустой bwrap root без
  `ro-bind /`, изолирует сеть и монтирует только минимальный runtime, текущий workspace,
  прошедшие boundary gate дополнительные каталоги (`extraDirs`, writable bind) и явно
  переданные read-only вложения. `kimi acp` флага `--add-dir` не имеет, поэтому
  дополнительные каталоги объявляются сессии через `[workspace] additional_dir` в
  `local.toml`: на каждый ход собирается per-run каталог-маска с одним server-owned
  `local.toml`, который заменяет `<projectRoot>/.kimi-code` целиком (ro-bind одиночного
  файла поверх ro-маски bwrap отклоняет). `projectRoot` вычисляется как у самого kimi —
  ближайший видимый предок cwd с `.git` (внутри sandbox это cwd либо доверенный
  extra-предок); у предка маска заодно скрывает его проектный `local.toml`, который
  иначе читался бы напрямую и мог объявить workspace-ом, например, `/kimi-home`.
  Доверенный каталог, СОДЕРЖАЩИЙ server-owned control state (например, общий
  родитель репозитория cockpit), не отклоняется: он монтируется, а control state
  внутри (kimi home, runtime/broker профиль, factory state/control, `chats/` с
  `.bindings`, `server/.state`, `.env`) прячется пустым read-only mount-ом поверх —
  ни чтение токенов в контекст, ни порча session/bindings/wrapper невозможны.
  Отклоняются только системные корни и сам control state как отдельный extra;
- Kimi получает заново построенные `HOME`, XDG и `KIMI_CODE_HOME`; provider, SSH, Git, npm/cloud
  credentials и host config/plugins/MCP/skills не наследуются;
- сервер создаёт отдельный Kimi home для каждого чата и привязывает ACP session к chat/provider,
  cwd, model, auth profile и security profile через CAS sidecar;
- [egress proxy](../../server/src/lib/kimi/egress-proxy.js) допускает только HTTPS CONNECT к точным
  `api.kimi.com:443` и `auth.kimi.com:443`, проверяет каждый DNS result и соединяется с уже
  проверенным публичным IP;
- дочерний Kimi process запускается без capabilities и с `no_new_privs`;
- systemd ограничивает runtime до `CPUQuota=200%`, `MemoryMax=2G`, `MemorySwapMax=0`,
  `TasksMax=256`, `RuntimeMaxSec=2h`, запрещает core dump и убивает всю cgroup при cancel/exit;
- [attachment staging](../../server/src/lib/kimi/attachments.js) не монтирует исходный общий
  каталог: regular files проверяются через fd с `O_NOFOLLOW`, копируются в private staging и
  становятся read-only;
- [ACP client](../../server/src/lib/kimi/acp-client.js) ограничивает размер входного frame и
  накопленного ответа; transport обрабатывает cancel и reverse requests без shell interpolation;
- ACP-режим сессии выставляется только из списка ниже; произвольная строка в
  `session/set_config_option` не проходит.

## Режимы прав: что даёт ACP, а что — кокпит

Бинарь объявляет четыре режима (`ACP_MODES` в `0.33.0`): `default`, `plan`, `auto`, `yolo`.
Кокпит показывает четыре пункта, но соответствие НЕ один-к-одному
([`kimi.js modes()`](../../server/src/lib/executors/kimi.js),
[`ACP_MODE_BY_PERMISSION`](../../server/src/lib/kimi/runtime.js)):

| пункт кокпита | ACP-режим | кто решает |
|---|---|---|
| «Спрашивать» | `default` | человек на каждый запрос |
| «Авто» | `default` | классификатор кокпита, остальное — человек |
| «План» | `plan` | человек подтверждает план |
| «Без подтверждений» | `yolo` | никто: Kimi не спрашивает вовсе |

Два неочевидных места:

- **«Авто» намеренно не мапится в ACP `auto`.** В родном `auto` решение принимает сам Kimi,
  и permission reverse RPC до кокпита не доходит — классификатору
  ([`auto-approve.js`](../../server/src/lib/chat/auto-approve.js)) нечего решать, а
  всплывашка перестаёт появляться. Поэтому «Авто» — политика ОТВЕТОВ поверх `default`:
  деструктивные и неизвестные действия по-прежнему уходят человеку (fail-closed).
- **«Без подтверждений» — родной `yolo`, а не имитация кокпита.** Имитировать его нечем и
  не нужно: авто-allow на каждый запрос стоил бы полного round-trip reverse RPC на каждое
  действие. Это осознанный выбор человека в конкретном чате, ровно как `dontAsk`/
  `bypassPermissions` у claude: в contained-профиле границу продолжает держать runtime
  (bwrap + cgroup + egress allowlist), в host-профиле её не держит ничто, кроме прав
  пользователя. Классификатор кокпита к этому режиму не применяется по определению —
  спросов, которые он мог бы разобрать, не существует.

## Проверки

[Offline adversarial suite](../../tests/server/kimi-security.test.js) покрывает traversal,
outside-root, symlink, directory, TOCTOU-sensitive staging, size limits, sensitive env, private и
special-use DNS/IP, broad workspace mounts и несоответствие runtime profile.

[Fake ACP lifecycle](../../tests/server/kimi-runtime.test.js) проверяет initialize, раннее
сохранение session ID, config, prompt, permission reverse RPC, `/status`, cancel и отсутствие retry
после подтверждённого prompt.

Contained probe Kimi `0.31.1` подтвердил без model prompt:

- `initialize` с ACP protocol `1`;
- authenticated `session/new`;
- получение и установку model/thinking/mode config options;
- штатный exit без утечки credential content.

Содержимое credentials не читалось, не копировалось и не логировалось. Этот probe не отправлял
model prompt и не расходовал квоту.

## Credential barrier снят

Первый живой ход с model prompt выявил несовместимость barrier-а с Kimi `0.31.1`: OAuthManager
перечитывает credential file на каждый model request (`ensureFresh → loadState → storage.load`,
in-memory cache между запросами нет). Unmount `/kimi-home/credentials` при первом CONNECT к
`api.kimi.com` пропускал только первый request: следующий (шаг 2, сразу после tool calls и
approve) получал `auth.login_required` → ACP `Authentication required`. Wire transcripts обеих
живых сессий обрывались на `step.begin` второго шага до построения `llm.request`.

Барьер и весь control-канал (control socket + umount) удалены: credentials остаются
смонтированными rw на весь запуск, refresh токена штатно пишется в host файл. Остаточный риск:
tool-код внутри sandbox способен прочитать OAuth-файл, но эксфильтрация ограничена egress
allowlist (только `api.kimi.com`/`auth.kimi.com`) либо записью в workspace — уровень экспозиции
не выше, чем у остальных исполнителей, работающих на host без sandbox. Long-term направление —
host-side token broker, выдающий sandbox только short-lived access tokens без `refresh_token`.

Отдельный явно разрешённый live smoke подтвердил egress и доставку до `llm.request`.
После отмены хода через UI transport отправил ACP cancel. Resume этой session принял следующий
prompt, но Kimi `0.31.1` не создал новый `llm.request` и вернул пустой ход — это закрепило
несовместимость resume-after-cancel для этой версии. Повторный автоматизированный smoke на `0.33.0`
(`tools/kimi-resume-smoke.mjs`)
показал, что баг исправлен: после cancel+resume модель отвечает штатно (RESUME_OK). Поэтому
stop больше не инвалидирует binding — оборванная session возобновляется следующим ходом.
Инвалидация остаётся только как страховка для пустого post-prompt результата (регресс
проглатывания) и по явному сбросу памяти; повторное сообщение в чистой session получает
досье сделанного (`lib/chat/stopped-brief.js`). Опасного автоповтора после принятого prompt
нет в обоих случаях.

## Оставшиеся ограничения MVP

- успешный многошаговый ответ после снятия credential barrier, question flow,
  `/compact` и cancel во время tool ещё требуют отдельных явно разрешённых квотных smoke;
- allowlist закреплён за Kimi Code `0.31.1`; новая версия или новые endpoints должны закрыто
  провалить compatibility/preflight до отдельного аудита;
- ACP-режим `auto` (решает сам Kimi) не выставлен: у кокпита «Авто» — своя политика поверх
  `default`, см. раздел о режимах. Произвольные MCP/plugins/skills и host config в
  contained-профиле остаются запрещены;
- нужно сохранить дополнительные обезличенные fixtures usage/context и успешного event ordering,
  а live adversarial suite расширить detached-child и DNS-rebinding сценариями.
