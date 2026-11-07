# Фикстуры режимов smoke GLM

При сверке 02.11.2026 `runGlmLiveSmoke` и CLI в `server/scripts/glmLiveSmoke.mts`
принимают `api` и `coding-plan`. В `tests/server/glm-live-binary.test.js` сохранились
два ожидания прежнего контракта:

- Тест `smoke не выдаёт DI admission для Coding Plan` ожидает `glm_mode_not_admitted`,
  но режим уже разрешён. С его фиктивным `workRoot: '/missing'` вызов доходит до
  `mkdtemp` и возвращает `ENOENT`.
- Тест `CLI без confirm-live отказывает до чтения env и запуска модели` включает
  комбинацию `--mode coding-plan --confirm-live --binary /missing --cache-dir /missing`.
  Это полный набор синтаксически допустимых аргументов; ожидаемый ранний код `2`
  к нему больше не относится.

Первое расхождение воспроизведено ограниченной проверкой без запуска ELF и модели:

```bash
bash tests/run-node-tests-safe.sh --test \
  --test-name-pattern='smoke не выдаёт DI admission для Coding Plan' \
  tests/server/glm-live-binary.test.js
```

Результат — код `1`, один упавший тест: фактически `ENOENT` вместо
`glm_mode_not_admitted`. Это состояние базы, а не регрессия правки документации.

CLI-тест не воспроизводился: его дочернему процессу передаются только `PATH` и
устаревший `GRIGDESK_DATA_HOME`. Общий резолвер использует `GRIGDESK_HOME` и
`GRIGDESK_ENV_FILE`; изоляция родителя сторожем не сохраняется при такой замене env
ребёнка. Теперь допустимая комбинация Coding Plan может обратиться к настоящему
env-файлу папки данных до отказа на отсутствующем ELF. Полный файл безопасно запускать
после исправления изоляции дочернего env и устаревших ожиданий.

Основной loopback-сценарий вызывает `runGlmLiveSmoke` напрямую с синтетическим ключом
и fetch guard. Он проверяет `api` и не покрывает CLI-запись `--admit` или живую
доступность Coding Plan. Отдельный `glm-smoke-diagnostics.test.js` проверяет очистку
ошибок HTTP и наблюдатель; при сверке прошли все три теста. Успех этих проверок
не означает зелёный результат всего `glm-live-binary.test.js`.
