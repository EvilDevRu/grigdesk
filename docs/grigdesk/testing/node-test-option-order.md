# Параметры Node test runner перед списком файлов

В Node 24 параметр `--test-concurrency=2` действует, когда расположен **перед**
первым путём теста. Вызов `node --test file.test.js --test-concurrency=2` не ограничивает
число workers: в `process.execArgv` тестового процесса остаётся `--test-concurrency=0`.
Для объёмного набора это может превысить суммарный лимит RSS даже при наличии сторожа.

Рабочая команда из корня проекта:

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh \
  --test --test-concurrency=2 tests/web/example.test.js tests/server/example.test.js
```

Сторож передаёт аргументы Node в исходном порядке. Перестановка флага не меняет
состав проверок и сохраняет ограничение памяти всей группы. Проверка порядка на
синтетическом тесте показала `--test-concurrency=2` в `process.execArgv` только во
втором варианте; при флаге после файлов группа большого прогона достигла RSS 4 ГиБ
и была остановлена сторожем.
