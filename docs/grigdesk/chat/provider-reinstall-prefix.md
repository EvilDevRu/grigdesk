# Переустановка сохраняет prefix прежней npm-копии

Для npm-копий первая установка и обслуживание найденной копии выбирают каталог
по-разному. `resolveUserCliNpm` читает `npm prefix -g` из двух форм пользовательского
Bash. Однако `prepareLifecycleContext` передаёт одновременно этот prefix и найденную
установку, а `prepareNpmStrategy` выбирает `selected?.prefix ?? input.prefix`.
`executeNpmStrategy` повторяет тот же выбор при построении настоящего npm argv.

Поэтому `update` и `reinstall` существующей копии из `<D>/state/npm-global` сохраняют
этот каталог, даже если обычный пользовательский npm теперь ставит глобальные пакеты
в другой prefix. Команда preview также содержит прежний каталог в явном `--prefix`.
Это фактическое поведение установки, а не только подпись окна.

Следствие: обслуживание такой копии не эквивалентно запуску
`npm install --global <package>@<version>` в пользовательской консоли без `--prefix`.
Совпадение выбранной команды CLI в GrigDesk и Bash этого не гарантирует: терминал
может запускать прежнюю копию через PATH, а npm устанавливать новые пакеты в другой
глобальный каталог. Для удаления выбранной копии её собственный prefix необходим.

Проверенные места:

- `server/src/lib/providerInstall/userCliEnvironment.ts` — определение prefix npm.
- `server/src/lib/providerInstall/lifecycleContext.ts` — выбор существующей копии и preview.
- `server/src/lib/providerInstall/npmStrategy.ts` — подготовка и выполнение в prefix копии.
- `tests/server/provider-lifecycle-service.test.js` — сценарий оставшейся npm-копии прямо
  закрепляет сохранение её прежнего prefix вместо текущего пользовательского.

Зелёные lifecycle-тесты подтверждают этот контракт обслуживания на месте, но не доказывают
совпадение каталога переустановки с обычной установкой из консоли.

Это правило относится только к `source=npm`. Для `source=native` preview не имеет
npm-prefix: update/reinstall повторяют официальный installer адаптера, а uninstall
удаляет объявленные программные цели. См. [стратегию](provider-native-lifecycle.md).
