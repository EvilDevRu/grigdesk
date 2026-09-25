# Мутации route attempt требуют exact identity

**Где:** `server/src/modules/factory`, `server/src/lib/factoryRouteCli.ts`.

Cockpit не пишет `tN.pipeline` напрямую: это только UI-проекция immutable ledger. Gate,
goto, abandon и resume вызывают `factory` с точными profile + attempt + node; движок делает
CAS в trusted control root и сам обновляет проекцию. Исторический Python-dashboard работает
только на чтение. Прямой upsert способен нарисовать принятые ворота в UI, не изменив cursor,
поэтому такая «оптимизация» является порчей состояния.

Источник до переноса: docs/cockpit/gotchas.md § Мутации route attempt требуют exact identity
