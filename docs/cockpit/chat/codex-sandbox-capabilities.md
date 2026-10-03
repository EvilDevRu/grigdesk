# Песочница Codex в чате: сеть и loopback есть, `systemctl --user`, FUSE и запись в `$HOME` — нет

Чат Codex идёт в песочнице `workspace-write` с включённой сетью
(`sandbox_workspace_write.network_access=true`). Что в ней реально доступно, проверено
2026-10-03 на `codex-cli 0.160.0`:
- запуском `codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true`;
- одним скриптом проб, выполненным и снаружи, и внутри песочницы.

Чат использует `app-server` с той же политикой песочницы. Отдельно путь `app-server` не
замерялся.

| Работает | Не работает |
|---|---|
| запись в рабочие корни и в `/tmp` | запись в остальной `$HOME` (`~/.cache`, `~/.npm`, `~/.config`, `~/.local/share`) и в `/run/user/<uid>`: «Файловая система доступна только для чтения» |
| сеть наружу (npm, GitHub) и TCP на `127.0.0.1` | `systemctl --user`: «Failed to connect to bus» |
| `bwrap`, `unshare -Ur`, `setpriv --pdeathsig`, `xvfb-run`, `dbus-run-session` | `/dev/fuse` отсутствует: AppImage не монтируется, работает только `--appimage-extract-and-run` |
| Chromium со своей песочницей: headless и под Xvfb, без `--no-sandbox` | чужие процессы не видны: своё пространство PID, в `ps` — несколько своих процессов |

Сопутствующее:
- В процессе стоят `NoNewPrivs: 1` и `Seccomp: 2`.
- Окружение наследует `NODE_ENV=production`: `npm install` без `--include=dev` выкидывает
  devDependencies.
- `npm`, установщик Electron и сборщики по умолчанию пишут кэш в `~/.npm` и `~/.cache` и
  падают на записи. Кэши нужно направлять внутрь рабочего корня: `npm_config_cache`,
  `electron_config_cache` (его читает установщик Electron), `ELECTRON_CACHE`,
  `ELECTRON_BUILDER_CACHE`, `XDG_CACHE_HOME`.

**`systemd-run --user` проходит, хотя `systemctl --user` — нет.** Юнит при этом
запускается менеджером пользователя **вне** песочницы, с полными правами. Это выход за
границу, которую задаёт `workspace-write`. В заданиях для Codex его нужно прямо запрещать,
а долгие команды запускать на переднем плане с таймаутом.

**`codex sandbox` не заменяет пробу чата.** `codex sandbox -P :workspace` с тем же
`-c sandbox_workspace_write.network_access=true` сеть не включает: нет DNS и нет даже TCP
на `127.0.0.1`. Возможности чата проверяются через `codex exec` с аргументами, как выше.
В `codex exec` из неинтерактивной оболочки stdin нужно закрыть (`</dev/null`): иначе CLI
пишет «Reading additional input from stdin...» и ждёт.
