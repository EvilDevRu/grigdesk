---
name: no-project-hardcode-in-engine
description: Пользователь жёстко против хардкода проекта в движке; в bin/factory-v2 он пока есть и подлежит выносу
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 84b283ed-88d9-4a07-ac85-503fa9382410
  modified: 2026-07-31T05:36:14.648Z
---

Пользователь явно отметил (июль 2026): хардкод проекта в движке недопустим — «не должно быть хардкода».
На тот момент `engine/bin/factory-v2` нарушал правило №1 движка: гейт `PROFILE == arsenkin`,
личные пути `/home/evildev/Workspace/arsenkin/...` (строки ~332+), whitelist маршрутов
`debug|feature|trivial`, имя контейнера, вызов `profiles/arsenkin/up.sh`; то же в тестах
`profile-runtime-contract.sh` и `route-v2-dispatch.sh` (абсолютные пути, зависимость от gitignored profiles/).

**Why:** правило «движок не знает ни одного проекта» — базовый инвариант engine/CLAUDE.md; лаунчер
даже source-ит profile.sh, где эти же данные уже объявлены, и затем перекрывает их константами.

**How to apply:** хардкод ВЫНЕСЕН 2026-07-31: семь v2-хуков (`profile_v2_*`) в
PROFILE-CONTRACT.md, гейт — capability `"route-v2"` в graph.json, `--profile` обязателен,
whitelist маршрутов удалён, `docker inspect` уехал в `profile_v2_sandbox_alive`.
Правило остаётся навсегда: любые новые проектные значения — только через хуки профиля.
Остаточный долг: тесты `profile-runtime-contract.sh`/`route-v2-dispatch.sh` ещё зависят
от локальных `profiles/` и абсолютных путей (план cutover, фаза 4). См. [[route-v2-motivation]].
