---
name: trace-marker-in-app-log
description: "Маркер трассировки в логе приложения внутри worktree валит cleanup транзакции (baseline_not_restored, код 75)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 338206f8-2c5b-4257-8355-e5fc1d29081c
  modified: 2026-08-03T04:21:49.217Z
---

Проверка `_instrumentation_tx_marker_absent_in_roots` намеренно включает ignored-файлы,
а вывод самой трассировки (`Log::info` с маркером `FACTORY-TRACE:t<TASK>`) приложение пишет
в `storage/logs/laravel.log` ВНУТРИ source root. Поэтому cleanup транзакции инструментации
никогда не сходится: исходник к baseline восстановлен побайтово, но маркер остался в логе →
`STATE=stalled REASON=baseline_not_restored` → 75 → маршрут встал fail-closed.
Впервые пойман на t7802 (2026-08-03, узел hyposkeptic, транзакция s12).

**Почему:** инвариант «артефакты трассировки живут вне source roots» противоречит тому, что
единственный штатный канал вывода трассировки в Laravel — лог внутри дерева. Родня
[[guard-false-positive-fix-source]]: снова охраняется то, что не переживает снос песочницы.

**How to apply:** различать маркер в ИСХОДНИКЕ (нарушение) и в логах/артефактах прогона
(ожидаемый результат) — исключать из проверки пути, которые движок сам объявил volatile-выводом,
либо требовать от профиля писать трассировку вне worktree. При разборе вставшей транзакции
искать маркер именно среди ignored-файлов: `git ls-files --others --ignored --exclude-standard`.
Побочно: путь `route_v2_cleanup_active_instrumentation` (outcome=failed) НЕ вызывает
`_route_v2_log_transaction_stall`, поэтому в журнале остаётся только «код 75» без причины.
