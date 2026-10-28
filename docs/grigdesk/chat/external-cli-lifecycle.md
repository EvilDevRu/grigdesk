# Lifecycle внешних CLI: установка, обслуживание и окружение

Claude, Codex и host Kimi объявляют `externalCli` и обслуживаются одним
`ProviderInstallService`. Обычные четыре операции (`install`, `update`, `reinstall`,
`uninstall`) выбирают стратегию по происхождению копии. Первая установка и npm-копии
используют пользовательский npm, найденный в новом Bash. Для копий из официального
installer update/reinstall запускают `installation(config).install`, uninstall удаляет
объявленные программные root/entry: [контракт](provider-native-lifecycle.md). Новая установка
использует его prefix, обслуживание существующей копии — её собственный prefix.
Сервис один: общий admission, один worker, общий
durable-state и одна lease-область.

## Подготовка и mutation

Для npm `prepare` разрешает точную версию, скачивает пакет без scripts в приватный
inspection-prefix и фиксирует полный граф зависимостей с integrity. В том же
приватном cache выполняется offline-прогон без scripts: он должен выбрать тот же
граф. `start` повторяет эту сверку до первой записи, проверяет Node/npm/npmrc,
cache и identity старой копии. Неизвестный lifecycle-hook закрывает операцию;
для registry tarball выполняются только install/uninstall-хуки,
`prepare`/`prepublish` принадлежат публикации пакета.

Точная npm-замена (`reinstall`) сохраняет выбранную версию и восстанавливает
повреждённый package tree из собственного backup. Новая копия проверяется по
физическому entry и `--version`. Права, `.claude`/`.codex`/`.kimi-code`,
credentials и история не входят в footprint.

## Оболочка, PTY и конвейер

Npm-стратегия v2 не пишет rc и не добавляет строк PATH. Официальный installer
исполняется по контракту адаптера, как в прежнем управляемом flow. Пользовательский PTY
запускает shell один раз с исходным PATH/prefix из bootstrap-маркера, без
серверного npm-prefix и служебных переменных. Внешний запуск агента, probe и
usage получают ту же выбранную копию через общий контекст и reader lease.

Factory передаёт закрытый descriptor выбранных внешних копий в env стадии.
Только external runner child запускается абсолютным путём через lease-helper;
managed DeepSeek/GLM и PATH оркестратора не меняются. Если descriptor недоступен,
runner сохраняет прежний поиск по PATH.

## Совместимость с прежней миграцией

В релизном интерфейсе нет команды «Привести установки в порядок», сервер не
публикует `canMigrate` и маршруты `/v2/migrations/prepare` и `/start`.
Внутренний код и чтение старых `migrate`-снимков сохранены для восстановления
операций предыдущей версии. Обычная установка после удаления снимает отсутствующую
привязку в рамках своего подтверждения, без запуска массового переноса:
[контракт](provider-install-stale-binding.md).

## Проверки

- `tests/server/provider-install-npm-strategy.test.js` — exact repair, offline
  rehearsal, изменение графа.
- `tests/server/provider-install-migration*.test.js` — preview, действия,
  общий блок, rollback и сервисный admission.
- `tests/server/terminal-pty.test.js` — среда PTY и parity login shell.
- `tests/engine/unit/external-cli-runtime.sh` — descriptor factory и helper.
- Официальная npm-матрица запускается только отдельным manifest:
  `tests/server/fixtures/provider-install/officialLifecycleSmoke.mjs`.
