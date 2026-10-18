# Дополнительные workspace-каталоги для kimi-чатов (паритет с codex --add-dir)

## Проблема

У codex- и claude-чатов дополнительные каталоги (репозитории выбранного проекта и
рабочие копии задачи) передаются в CLI флагами `--add-dir`, и модель
может читать/писать в них как в части workspace. У kimi-чатов проводка
`extraDirs` существовала (`modules/chat/index.js` → `lib/kimi/runtime.ts` →
`lib/kimi/sandbox.ts`), но ограничивалась writable bind-mount в sandbox namespace:
сам CLI про каталоги не узнавал, и его инструменты считали всё вне `cwd` чужим.

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Проблема

## Реализация

`server/src/lib/kimi/sandbox.ts`:

- На каждый ход из `canonicalExtras` собирается per-run каталог-маска
  `workspace-mask/` с одним server-owned `local.toml` (`buildWorkspaceLocalToml`).
  Файл атомарно пишется через temp+rename (0400), каталог чистится вместе с
  `runDir` — гонок между чатами нет.
- Маска заменяет `<projectRoot>/.kimi-code` **целиком** одним `--ro-bind`.
  Отдельный ro-bind файла поверх ro-маски невозможен: bwrap падает с
  `Can't create file ...: Read-only file system` (проверено на живом bwrap 0.6.1).
- `resolveVisibleProjectRoot` повторяет `findProjectRoot` kimi по видимым в
  sandbox каталогам: `cwd` с `.git` → он; иначе ближайший extra-предок с `.git`;
  иначе `cwd`. Предки без mount-ов и промежуточные `--dir` `.git` не несут.
- Широкий доверенный каталог (например, родитель репозитория grigdesk) **не
  отклоняется**: он монтируется целиком, а server-owned control state внутри него
  (`workspaceControlStatePaths`: `kimiHome`, runtime/broker contained-профиль,
  factory state/control, вся папка данных и отдельно заданный `.env`) прячется пустым `--ro-bind` поверх — тем же паттерном, что и маска
  `.kimi-code`. Вложенные control-пути маскирует ближайший перечисленный предок.
  Отклоняются теперь только системные корни (`/`, `/usr`, …) и сам control state
  как отдельный extra (`kimi_workspace_mount_is_control_state`) — после масок он
  всё равно пуст. Замаскированные пути пишутся в лог сервера
  (`maskedWorkspacePaths`).

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Реализация

## Безопасность

- Содержимое `local.toml` строится только из `canonicalExtras`; отклонённые
  (системные корни, сам control state) туда не попадают.
- Control state внутри смонтированного доверенного каталога недоступен ни на
  чтение, ни на запись: пустой ro-bind поверх. Чтение токена в контекст — это
  отправка его в prompt к API, а writable wrapper скриптов contained-профиля —
  инъекция в механику sandbox, поэтому маски обязательны, а не опциональны.
- Проект подменить содержимое `local.toml` не может: маска server-owned,
  проектный `.kimi-code` в sandbox не виден.
- Закрыта ранее существовавшая дыра: если доверенный предок `cwd`
  содержит `.git` и собственный `.kimi-code/local.toml`, kimi выбирал бы его
  как projectRoot и читал проектный файл напрямую — тот мог объявить
  workspace-ом, например, `/kimi-home` с OAuth credentials. Теперь
  `.kimi-code` такого предка тоже заменяется маской.
- Известный побочный эффект (pre-existing): bwrap создаёт destination-каталоги
  на хосте, если их не было (`.kimi-code`, masked-пути).

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Безопасность

## Проверка

- Живой ACP-сеанс с реальным `kimi acp` 0.31.1: сессия с `local.toml` получила
  в system prompt секцию «Additional Directories» с правами read/write/search/glob.
- Прогон настоящего argv из `buildKimiSandboxLaunch` через реальный bwrap:
  базовый сценарий (виден серверный `local.toml` с extra-каталогом), вложенный
  (`cwd` внутри доверенного предка с `.git` и «враждебным» проектным `local.toml`
  → виден серверный, проектный скрыт) и широкий доверенный родитель репозитория
  (каталог смонтирован и writable; прежние `chats/`, `server/.state` и `.env` — пустые
  read-only маски, запись в них даёт EROFS). Маски папки данных (вся папка каталогом,
  отдельный `.env` только вне её) проверены по argv тестами, настоящим bwrap — нет.
- `tests/server/kimi-security.test.js`: маска у cwd и у предка, пустой запуск
  без маски, содержимое `local.toml`, маски control state внутри широкого extra,
  отказ для самого control state, отдельный тест `resolveVisibleProjectRoot`.
  Весь kimi-набор зелёный.

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Проверка

## Раскатка

1. Перезапустить grigdesk-server (код рантайма загружается при старте):
   `deploy/restart.sh` или `systemctl --user restart grigdesk-server`.
2. В чате выбрать проект кнопкой 📁 или привязать задачу с несколькими рабочими копиями.
   Сервер передаёт дополнительные корни в contained runtime, маскируя control state.
   Общая настройка доверенных каталогов удалена; host-профиль остаётся single-root.

Связанные документы: [папка чата](../guide/chat-workdir.md),
[kimi-runtime-security.md](kimi-runtime-security.md) («Границы contained runtime»).

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Раскатка

## Почему не --add-dir

По коду pinned CLI 0.31.1 (strings из бинарника):

- `registerAcpCommand` читает только `--login`; программный `--add-dir` в ACP
  игнорируется, а ACP `session/new` принимает лишь `cwd`/`mcpServers`;
- зато `createSessionWithOverrides`/`resumeSessionWithOverrides` всегда читают
  `<projectRoot>/.kimi-code/local.toml` → `[workspace] additional_dir`
  (packages/agent-core `config/workspace-local.ts`); это документированный
  механизм (`/add-dir` в TUI пишет тот же файл).

Источник до переноса: docs/grigdesk/kimi-workspace-extra-dirs.md § Почему не --add-dir
