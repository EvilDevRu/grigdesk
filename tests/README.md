# Тесты GrigDesk

Все тесты проекта собраны в одном корневом каталоге и разделены по подсистемам:

```text
tests/
├── docs/     # переносимость Markdown-ссылок и целостность документации
├── engine/   # unit, contract, integration, characterization, race и fixtures
├── server/   # API и серверные адаптеры
└── web/      # UI-контракты
```

Полный безопасный прогон без запуска GrigDesk и без вызовов реальных ИИ:

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
node --test tests/docs/*.test.mjs tests/docs/*.test.mts
```

Сервер и web сохраняют привычные команды:

```bash
npm --prefix server test
npm --prefix web test
```

Отдельные файлы — тоже через сторож памяти: голый `node --test` его не получает, и упавший
веб-тест однажды занял всю ОЗУ и подкачку
([ловушка](../docs/grigdesk/testing/happy-dom-assert-memory.md)).

```bash
bash tests/run-node-tests-safe.sh --test tests/web/<файл>.test.js
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 <файлы>
```

Файлы внутри набора идут параллельно (`--test-concurrency`: сервер 6, web 4), а суммарный
RSS всей группы ограничивает `tests/run-node-tests-safe.sh`. Бюджет задаётся переменной
`NODE_TEST_MAX_RSS_MB` и обязан быть не меньше гигабайта на одновременный файл — это
проверяют контракты `tests/server/test-runner-memory.contract.test.js` и
`tests/web/test-runner-memory.contract.test.js`.

Серверные контракты отдельно фиксируют abort обоих chat executor-ов, отсутствие зависимости
исходников от удалённого B24-проекта, чтение локальной canonical runner policy/attempt и
безопасную команду runtime-switch. Web-тесты фиксируют provider-neutral подписи цепочки,
модели и причины failover.

Harness движка держит runtime и тестовые ресурсы раздельно:
`FACTORY_HOME=<root>/engine`, `FACTORY_TESTS_HOME=<root>/tests/engine`.
