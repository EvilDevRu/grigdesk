# Мутации route attempt требуют exact identity

**Где:** `server/src/modules/factory`, `server/src/lib/factoryRouteCli.ts`.

GrigDesk не пишет `tN.pipeline` напрямую: это только UI-проекция immutable ledger. Gate,
goto, abandon и resume вызывают `factory` с точными profile + attempt + node; движок делает
CAS в trusted control root и сам обновляет проекцию. Исторический Python-dashboard работает
только на чтение. Прямой upsert способен нарисовать принятые ворота в UI, не изменив cursor,
поэтому такая «оптимизация» является порчей состояния.

Источник до переноса: docs/grigdesk/gotchas.md § Мутации route attempt требуют exact identity

В автономной поставке authority runtime pin выбирается перед вызовом существующей попытки.
После замены сервера B решение ворот и resume продолжают engine A и его helper Node, сохраняя
exact attempt/catalog/route identity. Новая попытка закрепляет текущий runtime до active pointer.
Legacy/source получают sidecar при первом безопасном продолжении после проверки protocol v2.
Pin не получает прав писать курсор или result; отсутствие ожидаемого pin даёт typed-отказ.
