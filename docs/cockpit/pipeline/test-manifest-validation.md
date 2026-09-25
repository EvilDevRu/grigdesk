# «TESTS: узел вернул решение человеку» при победном отчёте агента = сторож отверг manifest тестов, а сторож отстал от проекта

Симптом: карточка остановки говорит «TESTS: узел вернул решение человеку — прочитай его
замечание», а замечание агента рапортует об успехе («тесты написаны, красные по ожидаемым
причинам, digest записан»). В реестре узел числится `done`, в журнале попытки коммит узла —
`failed` с `reason: null`. Настоящая причина лежала только в `t<TASK>.route-v2.log`:

```text
feature-verify snapshot: manifest нельзя полностью выполнить: frontend:tests/unit/<файл>.test.mjs
route-v2 runtime: TESTS evidence rejected runner result (rc=78)
```

Две разные беды в одном случае:

1. **Петля обратной связи.** Правило о содержимом manifest жило только в промпте TESTS, а
   проверял его хост ПОСЛЕ выхода раннера — исправлять было некому, и причину человек носил
   агенту сам через «перейти сюда».
2. **Отставший сторож.** Агент положил в `t<TASK>.tests.sha256` FE unit-тест по плану
   («структурный unit»), а VERIFY профиля исполнял только Pest и Playwright — хотя node:test
   (`test:unit` = `node --experimental-strip-types --test "tests/unit/**/*.test.mjs"`) в
   проекте штатно с задачи <TASK>. Первый диагноз «агент нарушил правило» был неверен: отстал
   профиль. Убрать тест из manifest — значит сузить доказательство задачи (файл не заморожен,
   VERIFY его не гоняет).

Что сделано (16.09.2026):

- **Предпроверка сдачи (движок + профиль).** `profile_stage_result_check` отдаёт путь
  `stage-result-check.sh`; движок экспортирует его агенту как `FACTORY_STAGE_RESULT_CHECK`,
  `stage-result.sh` зовёт его ДО записи `done` и при отказе печатает причину, ничего не
  записав (код 65). Для TESTS это `feature-verify.py check` — тот же `parse_manifest`.
- **Отказ сторожа возвращается агенту (движок).** Отказ evidence-хука даёт узлу один повтор
  вне `productFailure` с цитатой последней строки хука в блоке «Это повтор этапа»
  (`FACTORY_STAGE_RETRY_REASON=evidence-rejected`, `FACTORY_STAGE_RETRY_NOTE`). Второй
  отказ подряд — `failed` → human.
- **Видимость (движок + кокпит).** Узел переводится в `failed`, причина — в
  `<RUN_KEY>_COMMENT` поверх отчёта агента и в строке журнала
  `маршрут остановлен: human — сторож отверг сдачу — <причина>`; `stall.ts` показывает её
  в заголовке карточки.
- **VERIFY знает node:test (профиль).** `feature-verify.py`: единая классификация
  `test_kind` (php / e2e / unit) для manifest, light-режима и владельца замечаний ESLint;
  unit-тесты гоняет обёртка `unit.sh <TASK> [файлы]` (worktree из `t<TASK>.env`, nvm-node,
  `--experimental-strip-types`), она же в allow-листе агента и в промптах TESTS/TCRITIC/BUILD.
  Владелец замечаний ESLint по спекам теперь `tests`, а не `build` (префикс `e2e/` не
  совпадал с `tests/e2e/` проекта); `.mjs/.mts` попали в охват линта.

Проверка без маршрута:

```bash
python3 profiles/<PROFILE>/feature-verify.py check <TASK> ~/.factory/state/t<TASK>.tests.sha256 \
  backend=<BE_WT> frontend=<FE_WT>
bash profiles/<PROFILE>/unit.sh <TASK> tests/unit/<путь>.test.mjs
```

Промпты дополнены (правило manifest с node:test, блок про `unit.sh`) — попадают в новые
попытки только после `publish.mjs --publish`; движок и профиль подхватываются на следующем
же этапе, поэтому для живой задачи хватило «перейти сюда» с указанием.
