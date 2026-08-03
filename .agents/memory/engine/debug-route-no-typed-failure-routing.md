---
name: debug-route-no-typed-failure-routing
description: "Типизированная маршрутизация отказов есть только у feature/consilium-feature; в debug добавлена 03.08.2026, у hunt/perf/trivial/consilium-debug её нет"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8011b8b0-bbc3-402d-8fc5-a0f4e7f4b817
  modified: 2026-08-03T09:16:44.459Z
---

Типизированная маршрутизация (`onFailure`: владелец → действие) была только у `feature` и
`consilium-feature`. Без неё `--failure-owner human` инертен: маршрут едет по `on.failed`.
03.08.2026 в исходник `debug` (profiles/arsenkin/routes/definition.mjs) добавлен помощник
`ownedFailureRoutes` и `onFailure` узлам diagnose/hyposkeptic/proof (`human`/`environment` →
`stop: human`, `plan` → прежний rewind на instrument) + подсказки в трёх base-промптах.
**Без onFailure остаются `consilium-debug`, `hunt`, `perf`, `trivial`.**

**Почему:** петля instrument→diagnose→hyposkeptic не сходится, когда недостающий вход —
решение человека или наблюдение пользователя, а не новые данные. На 7802 это стоило
8 эпох в первой попытке (брошена человеком) и ещё 3 круга Opus во второй при недельном
лимите на 90%. Движок остановит сам только по `rewind-limit` (6 возвратов при typed
verdict) или `no-progress` (тот же набор finding id трижды подряд) — то есть поздно.

**Как применять:** правя маршруты профиля, добавлять `onFailure` диагностическим узлам
по образцу feature-definition.mjs. Правка исходника не действует, пока бандл не
опубликован (`routes/publish.mjs --publish`), а идущая попытка всё равно приколота
к своей immutable-ревизии. Где onFailure ещё нет — следить за петлёй руками:
остановить конвейер и вернуть курсор через «перейти сюда» с комментарием (до 500
символов, доезжает агенту как указание человека). См. [[wait-for-human-password]].
