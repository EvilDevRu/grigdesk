# npm подготовки и durable installer state

Проверено на Node v22.22.1 и npm 10.9.4: runner выбирает абсолютный npm рядом с Node
сервера. Перед spawn повторяет проверку дерева, package.json и lock graph. Команда
ci использует omit=dev, ignore-scripts, no-audit/no-fund, фиксированный registry,
два разных пустых config0600, отдельный cache и явный prefix проверенной папки.
Env собирается заново с trusted PATH, приватными HOME/TMPDIR и C locale.

Offline fixture изготовляет tarballs без выполнения scripts и наполняет только свой
cache. Реальный npm устанавливает production/transitive graph, пропускает dev;
preinstall/install/postinstall/prepare markers не появляются. Без этого cache offline
команда получает ENOTCACHED. Контроль без ignore-scripts создавал root и transitive
markers. Вредные parent package/.npmrc не меняют install при фиксированном prefix.
Повторная проверка payload и единый job workspace budget выполняются до ready.

State store читает ограниченный обычный файл (10 МиБ), проверяет schema1, весь DTO,
record/intent/job связи, revisions, identities и безопасные ключи. Неисправный state
сохраняется, ENOENT означает новый state только без work evidence. Записи сериализованы
withPathLock и используют writeDurableFile: tmp0600, fsync, rename, parent fsync.
После ошибки writer вызывающий обязан перечитать диск: ошибка после rename не отменяет
фактическую публикацию. Store не выполняет recovery или cleanup сам.

CompletedJobs содержит последние 32 terminal summaries без diff. Live job, apply intent,
последний rollback receipt и durable worker registry сохраняются независимо. Receipt
input rollback и archiveKey обязаны существовать до файловых эффектов. Десять параллельных
storage mutate проверены без потери revisions; admission mutex сервиса проверяется отдельно.

Проверки: plugin-install-npm, plugin-install-npm-offline, plugin-install-state.
Runtime lifecycle, транзакция публикации и HTTP installer не следуют автоматически
из этих гарантий: они имеют отдельные проверки и допуск.
