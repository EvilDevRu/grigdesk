# Стадии — глобальный enum (server/src/lib/stages.ts)

`STAGES` — каталог всех стадий (kind + подпись по умолчанию), `StageKind` (agent/human/code).
Профили ССЫЛАЮТСЯ на id и оверрайдят через graph.json (`resolveNode`). `GET /api/factory/stages`.
Редактор «Маршруты» уже использует этот каталог: стадии выбираются из общей библиотеки,
цепочка/возвраты/промпты сохраняются по проектам. Сам `profiles/<profile>/graph.json` остаётся
engine-контрактом координат и runtime-графа, а не редактируется как произвольный JSON из UI.

Источник до переноса: docs/cockpit/factory-graph.md § Стадии — глобальный enum (server/src/lib/stages.js)
