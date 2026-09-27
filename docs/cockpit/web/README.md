# Интерфейс

Устройство web/src: раскладка, слои и Escape, всплывашки, PWA, настройки устройства.

Читай перед правкой: `web/src/shared`, `web/src/services`, `web/src/composables`, `web/src/stores`.

## Контракты продукта

- [Журнал окна](../guide/web-log.md)

## Устройство

- [Веб (web/src/)](frontend-architecture.md)
- [Вид — третичный уровень без заголовка](view-navigation-level.md)
- [Горячие клавиши инструментов — настройка устройства](device-tool-shortcuts.md)
- [Звонят все три беды вотчера, а не две](watcher-alert-sounds.md)
- [Проект — главный уровень панели](project-navigation-level.md)
- [Пропорции страницы «Чаты» — тоже настройка устройства](chat-layout-preferences.md)
- [Рабочая сводка топбара остаётся короткой](topbar-summary.md)
- [Размеры раскладки — настройка УСТРОЙСТВА](device-layout-preferences.md)
- [Состояние — второй, визуально тихий уровень в той же строке](status-navigation-level.md)
- [Фильтры доски адаптируются по ширине самой карточки, а не viewport](board-filter-container-width.md)
- [Чипы «требует меня» в навигации](navigation-attention-badges.md)
- [Code, Shelf, Terminal и SSH монтирует только постоянный shared/layout/ToolHost.vue](persistent-tool-host.md)
- [Escape координирует единый typed stack](escape-stack.md)

## Грабли

- [Долгие POST чатов, накопление опросов и исчезновение метрик при сбое транспорта](../chat/concurrent-send-transport.md)
- [«Кокпит завис, все запросы (ожидает)» = съеден лимит соединений браузера](browser-connection-limit.md)
- [Колонка чата без min-width: 0 — длинная команда выталкивает кнопки за экран](chat-column-overflow.md)
- [Подразделы настроек не наследуют стили SettingsView (scoped CSS)](settings-scoped-styles.md)
- [Событие есть на сервере, ветка есть во фронте, а не работает — забыли EVENT_NAMES](sse-event-registration.md)
- [Таймер в state стора + $subscribe = бесконечный круг](store-timer-subscription-loop.md)
- [Установка «как приложение»: три условия, иконки — отдельный блокер](pwa-installation-requirements.md)
- [Alt+Shift+клавиша не доходит до страницы: пару забирает переключатель раскладки](keyboard-layout-shortcut-conflict.md)
- [Code/Shelf/Terminal нельзя монтировать отдельно в route и в правом доке](duplicate-tool-mounts.md)
- [Escape закрывает только верхний слой](escape-top-layer.md)
- [Service Worker кэширует — правки не видны без «Обновить»](service-worker-cache-refresh.md)
- [Service Worker требует secure context — по http://<IP> PWA НЕ существует](pwa-secure-context.md)
- [Tooltip/popover живут в <body>: scoped-селектор consumer-а до surface не дотянется](teleported-overlay-styles.md)
