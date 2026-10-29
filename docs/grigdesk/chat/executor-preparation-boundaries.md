# Подготовка внешнего CLI и повторное использование процесса

`ExecutorAdapter.prepareRuntime` — optional capability. Общий chat route вызывает её
до native settings и binding, передавая optional server-owned permissionModeContext.
Runtime handle остаётся непрозрачным для HTTP и истории.

`providerInstall/externalCliAdapter.ts` выбирает внешний runtime для probe, каталогов,
run, session.open и native settings context. Для адаптера с prepareRuntime выбранные
executable и окружение закреплены за returned handle приватной WeakMap. Settings и
run/open с этим handle не делают новый discovery; send живого процесса сохраняет
process context. Контекст native settings включает runtime fingerprint, а cloned
launch plan проверяется по fingerprint и payload до запуска. Путь без handle
сохраняет прежнее поведение остальных адаптеров. Lease проверяет identity до spawn.

Пул `chat/liveSessions.ts` решает reuse по `session.restartOn` адаптера либо общему
списку. Сам новый handle процесс не закрывает. У Codex в список входят model, effort,
cwd, extraDirs, compactWindow, providerSettings, nativeSettingsFingerprint,
workToolScopeKey, workspaceAccess, permissionMode, modeSelection и runtimeProfileFingerprint.
Новый handle с тем же fingerprint не требует restart. Перед сменой optional
prepareTransition подтверждает остановку учтённых native tools; отказ не открывает
следующий процесс. Детали и ограничения — [режимы Codex](codex-permission-modes.md).

Проводка проверена targeted-тестами wrapper, runtime и живых сессий; установленный
CLI отдельно проверен с loopback-моделью. Это не полный live-допуск всех профилей.
