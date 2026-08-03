# Дополнительные workspace-каталоги для kimi-чатов (паритет с codex --add-dir)

Дата: 2026-08-02. Затронутый компонент: contained ACP runtime Kimi
(`server/src/lib/kimi/`), чат-рантайм Cockpit.

## Проблема

У codex- и claude-чатов доверенные каталоги (`prefs.trustedDirectories` и
дополнительные worktree задачи) передаются в CLI флагами `--add-dir`, и модель
может читать/писать в них как в части workspace. У kimi-чатов проводка
`extraDirs` существовала (`modules/chat/index.js` → `lib/kimi/runtime.js` →
`lib/kimi/sandbox.js`), но ограничивалась writable bind-mount в sandbox namespace:
сам CLI про каталоги не узнавал, и его инструменты считали всё вне `cwd` чужим.

## Почему не `--add-dir`

По коду pinned CLI 0.31.1 (strings из бинарника):

- `registerAcpCommand` читает только `--login`; программный `--add-dir` в ACP
  игнорируется, а ACP `session/new` принимает лишь `cwd`/`mcpServers`;
- зато `createSessionWithOverrides`/`resumeSessionWithOverrides` всегда читают
  `<projectRoot>/.kimi-code/local.toml` → `[workspace] additional_dir`
  (packages/agent-core `config/workspace-local.ts`); это документированный
  механизм (`/add-dir` в TUI пишет тот же файл).

## Реализация

`server/src/lib/kimi/sandbox.js`:

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
- Широкий доверенный каталог (например, родитель репозитория cockpit) **не
  отклоняется**: он монтируется целиком, а server-owned control state внутри него
  (`workspaceControlStatePaths`: `kimiHome`, runtime/broker contained-профиль,
  factory state/control, `chatsDir` с `.bindings`, `server/.state`, `.env`
  репозитория) прячется пустым `--ro-bind` поверх — тем же паттерном, что и маска
  `.kimi-code`. Вложенные control-пути маскирует ближайший перечисленный предок.
  Отклоняются теперь только системные корни (`/`, `/usr`, …) и сам control state
  как отдельный extra (`kimi_workspace_mount_is_control_state`) — после масок он
  всё равно пуст. Замаскированные пути пишутся в лог сервера
  (`maskedWorkspacePaths`).

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

## Проверка

- Живой ACP-сеанс с реальным `kimi acp` 0.31.1: сессия с `local.toml` получила
  в system prompt секцию «Additional Directories» с правами read/write/search/glob.
- Прогон настоящего argv из `buildKimiSandboxLaunch` через реальный bwrap:
  базовый сценарий (виден серверный `local.toml` с extra-каталогом), вложенный
  (`cwd` внутри доверенного предка с `.git` и «враждебным» проектным `local.toml`
  → виден серверный, проектный скрыт) и широкий доверенный родитель репозитория
  (каталог смонтирован и writable; `chats/`, `server/.state`, `.env` — пустые
  read-only маски, запись в них даёт EROFS).
- `tests/server/kimi-security.test.js`: маска у cwd и у предка, пустой запуск
  без маски, содержимое `local.toml`, маски control state внутри широкого extra,
  отказ для самого control state, отдельный тест `resolveVisibleProjectRoot`.
  Весь kimi-набор зелёный.

## Раскатка

1. Перезапустить cockpit-server (код рантайма загружается при старте):
   `bin/restart` или `systemctl --user restart cockpit-server`.
2. «Настройки → Исполнители → Доверенные каталоги» — добавить нужные пути.
   Можно доверять и общий родительский каталог (например, `~/Workspace`, где
   лежит сам cockpit): служебные пути cockpit внутри него будут автоматически
   замаскированы, о чём сервер пишет в лог. Действует со следующего хода любого
   kimi-чата, дальнейших рестартов не требует.

Связанные документы: [chat-agents.md](chat-agents.md) («Доверенные каталоги»),
[kimi-runtime-security.md](kimi-runtime-security.md) («Границы contained runtime»).
