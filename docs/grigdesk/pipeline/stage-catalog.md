# Стадии — глобальный enum (server/src/lib/stages.ts)

`STAGES` — каталог всех стадий (kind + подпись по умолчанию), `StageKind` (agent/human/code).
Профили ССЫЛАЮТСЯ на id и оверрайдят через graph.json (`resolveNode`). `GET /api/factory/stages`.
Web эту ручку не вызывает, и редактор «Маршруты» каталог не читает: новый этап создаётся
по типу (агент ИИ, команда, решение человека, статус) с ключом `AGENT`, `AGENT_2`… и пустой
инструкцией. Готовых заготовок этапов в редакторе нет. Сам `profiles/<profile>/graph.json`
остаётся engine-контрактом координат и runtime-графа, а не редактируется как произвольный JSON из UI.

Источник до переноса: docs/grigdesk/factory-graph.md § Стадии — глобальный enum (server/src/lib/stages.js)
