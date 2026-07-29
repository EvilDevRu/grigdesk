# Тесты Cockpit

Все тесты проекта собраны в одном корневом каталоге и разделены по подсистемам:

```text
tests/
├── docs/     # переносимость Markdown-ссылок и целостность документации
├── engine/   # unit, contract, integration, characterization, race и fixtures
├── server/   # API и серверные адаптеры
└── web/      # UI-контракты
```

Полный безопасный прогон без запуска Cockpit и без вызовов реальных ИИ:

```bash
bash tests/run-all.sh
```

`tests/layout.sh` входит в этот прогон и не даёт снова создать локальные
`engine/tests`, `server/test`, `web/test`, `engine/docs` или скрытый
`.claude/knowledge`.

Только движок:

```bash
bash tests/engine/run-offline.sh
bash tests/engine/run-offline.sh debug-settings.sh
TEST_REPEAT=50 bash tests/engine/run-offline.sh debug-settings-writer.sh
```

Только документация:

```bash
node --test tests/docs/*.test.mjs
```

Сервер и web сохраняют привычные команды:

```bash
npm --prefix server test
npm --prefix web test
```

Серверные контракты отдельно фиксируют abort обоих chat executor-ов, отсутствие зависимости
исходников от удалённого B24-проекта, чтение локальной canonical runner policy/attempt и
безопасную команду runtime-switch. Web-тесты фиксируют provider-neutral подписи цепочки,
модели и причины failover.

Harness движка держит runtime и тестовые ресурсы раздельно:
`FACTORY_HOME=<root>/engine`, `FACTORY_TESTS_HOME=<root>/tests/engine`.
