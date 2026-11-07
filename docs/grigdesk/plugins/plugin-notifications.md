# Серверные оповещения внешних панелей

Сервер плагина публикует исход через `core.emit('notification', payload)`.
Оболочка показывает его через общий центр независимо от открытия панели.
Импорт UI и acquirePanel/acquireSlot для этого не требуются.

## Данные и поколения

Show содержит id, dedupKey, topic, буквальные title/body `{ru,en}`, необязательные
tone/sticky/params. Decoder закрытый: scope/target/url и неизвестные поля не принимаются.
Для params действуют общие ограничения адресных намерений панели. Другие события:
dismiss по id, dismiss-topic по теме и clear своей серверной области.

Только notification получает envelope `{pluginId,generation,event,data}`.
Обычные plugin-event сохраняют прежнюю форму. UUID принадлежит runtime и совпадает
в каталоге runtimeGeneration, live event и snapshot. Core читает getter текущего
конкретного entry непосредственно перед broadcast, без await. Off/not-ready/closed
и старый entry после replacement не публикуют уведомления. Off/on меняет UUID,
даже когда серверный core остаётся тем же.

## Восстановление

Optional `lifecycle.notifications(signal)` возвращает durable recent show-исходы.
Продукт отбирает terminal за последние 24 часа; общий hook не читает историю провайдера
и не создаёт оплачиваемые запросы. Общий auth endpoint `GET /api/plugins/notifications`
вызывает hooks только загруженных enabled compatible runtime с объявленной панелью.
Включения и импорта server/UI при чтении endpoint нет.

Ответ: `{plugins:[{pluginId,generation,items,error}]}`. Параллельны два hook,
каждый имеет отдельный signal и timeout 5 секунд. В ответ входят последние 500 show,
не больше 1 МиБ JSON UTF-8 на плагин. Ошибка одного hook не прячет соседние результаты;
передаются безопасные коды. Таймаут отзывает signal, late result игнорируется.
Повторная проверка entry identity и UUID после await отбрасывает исходы старого on/off.

Клиент подписывается на общий SSE до snapshot и принимает только свежий каталог,
владельца и generation. Live и snapshot проходят один dedup. Повторное подключение
и hello восстанавливают пропущенное; ошибка видна с явным повтором.
Серверный канал `plugin-server:<encodedId>` отделён от UI `plugin:<encodedId>`.
Последний release панели не снимает серверные тосты.

## Просмотр и язык

Панель сообщает текущую тему через optional `context.notifications.setViewing(topic|null)`.
Просмотр действует только при panelActive и живом context соответствующих owner/generation.
Он сразу снимает уже показанные тосты темы; последующие исходы этой темы помечаются seen.
Скрытие, abort и смена владельца снимают просмотр.

Seen хранит последние 500 dedupKey в
`grigdesk-plugin-notifications-seen:<clientScope>:<pluginId>`. Перед записью storage
перечитывается для согласования окон. Запрет storage оставляет bounded memory cache.
Logout очищает память и тосты; данные других владельцев не читаются и не удаляются.

При прямом переносе Studio3D bridge до первой доставки импортирует только текущий
grigdesk-studio3d-seen:<clientScope> в общий target того же owner/studio3d.
Union сохраняет последние 500 ключей. Marker записывается после target; отказ marker
повторяет безопасный union, отказ target сохраняет union в памяти без marker.
Старый ключ не меняется и остаётся для ручного отката; зеркальной записи в него нет.

Проверенные буквальные title/body превращаются в frozen LocalizedText.
Общий render выбирает ru/en без поиска ключа и интерполяции; смена языка не создаёт
повторное системное уведомление и не меняет id/target/sticky.

Проверки: plugin-notifications и plugin-server-notifications, общий i18n-core,
plugin-core/runtime/hot-runtime. Фикстуры не обращаются к живым провайдерам.
