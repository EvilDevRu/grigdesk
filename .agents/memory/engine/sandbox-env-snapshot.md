---
name: sandbox-env-snapshot
description: .env.testing трекается в git и правится самим подъёмом песочницы — VERIFY отличает это от правок агента по снимку t<task>.sandbox-env.sha256
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d4375b2-3f42-4486-9e63-bfeca291e41b
  modified: 2026-08-03T08:12:04.961Z
---

В профиле arsenkin `.env.testing` **трекается в git**, а `up.sh` при подъёме песочницы
подставляет в него схемы прогона (`db_tNNNN`, `user_db_*`), тенанта и живые регионы —
worktree становится «грязным» неизбежно, на каждом прогоне.

**Why:** сторож diff-гигиены в `profiles/arsenkin/feature-verify.py` валит прогон на любом
изменённом `.env*` (finding `verify-local-env-pollution`). До 03.08.2026 он не отличал правку
песочницы от правки агента и потому валил VERIFY у КАЖДОГО прогона feature-маршрута
(на задаче 7788 — после 15 часов работы конвейера). Это тот же класс, что [[guard-false-positive-fix-source]].

**How to apply:** `up.sh` пишет снимок `$STATE_DIR/t<task>.sandbox-env.sha256`
(строки `<sha256>  <repo>:<путь>`, функция `sandbox_env_snapshot` в `lib.sh`), `down.sh` его удаляет
при сносе, а verify пропускает env-файл только при совпадении хеша байт-в-байт — любая правка
агента снимок ломает и снова считается загрязнением. Снимка нет — проверка строгая, как раньше.
Профиль вне Git, поэтому в истории репозитория этого не найти.
