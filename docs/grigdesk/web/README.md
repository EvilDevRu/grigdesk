# Интерфейс

Устройство web/src: раскладка, слои и Escape, всплывашки, пакет приложения, настройки устройства.

Связь оболочки, трубы и сервера — в [схеме единого приложения](../overview/unified-client.md).

Читай перед правкой: `web/src/shared`, `web/src/services`, `web/src/composables`, `web/src/stores`.

## Контракты продукта

- [Desktop: единая геометрия, постоянные рейки и пользовательские размеры](desktop-ui-density.md)

- [Журнал окна](../guide/web-log.md)

## Устройство

- [Локальная труба приложения: встроенный UI, запросы и потоки](client-pipe.md)
- [Сенсорная раскладка полного приложения](client-responsive.md)
- [Клиент оболочки: обнаружение, состояния и опрос](client-shell.md)
- [Машины и связь: выбор, привязка и восстановление](connections.md)
- [Сохранение файлов и системная кнопка «Назад»](native-actions.md)

- [Общее открытие настроек: маршрут, авторизация и переходы к инструментам](settings-navigation.md)

- [Подключения: Б24, пароль и прежняя привязка телефона](settings-connections.md)

- [Система: staged-автозапуск, обновления, журнал и процессы](settings-system.md)

- [Параметры плагинов: полный PUT, размещения и порядок включения](settings-plugins.md)

- [Параметры исполнителей: общая сессия, ключи и существующая очередь CAS](settings-providers.md)

- [Оболочка настроек: общий диалог, закрытие, авторизация и UI-контекст](settings-modal.md)

- [Каталог страниц настроек: порядок, перенос старой вкладки и адрес поля](settings-catalog.md)

- [Сессия настроек: черновик, конфликты, секреты и поздние ответы](settings-session.md)

- [Применение настроек: последовательная очередь, частичный результат и неизвестный исход](settings-apply.md)

- [Общая оболочка модальных окон и исключения редактора маршрутов](modal-shell.md)

- [Перенос профиля окна: настройки, базы, одна новая сессия](desktop-profile-rename.md)

- [Узкие рабочие области: выбор панели, общая ось страниц и меню инструментов](layout-workspace-navigation.md)

- [Геометрия ревью: разные внешние оси страниц и выход меню инструментов за низкое окно](layout-review-geometry.md)

- [Доработки визуального разбора: читаемые действия, компактные настройки и узкий просмотр изменений](ui-design-refinements.md)

- [Основа визуального разбора: галерея, источники стилей и проверенные различия](ui-inventory.md)

- [Карта экранов: 24 маршрута, вкладки настроек, модальные окна и условия сверки](ui-screen-inventory.md)

- [Наблюдения аудита: знаки действий, подписи switch, ghost/text и контекстные размеры](ui-audit-observations.md)

- [Главный процесс окна: загрузка документов и доставка настроек](desktop-main-boundaries.md)

- [Модули просмотрщика 3D: parser, ресурсы, общий бюджет и lifecycle загрузки](studio3d-viewer-modules.md)

- [Форма создания 3D: входы, расчёт, черновики и подтверждение пачки](studio3d-creation-form.md)

- [Клиент 3D: типы нажатий, durable отправка и порты Pinia](studio3d-client-boundaries.md)

- [Проекция установки: экраны, тексты, тоны и доступность действий](plugin-install-view-state.md)

- [Сенсорный размер общих элементов и диалогов через data-ui-touch](touch-control-size.md)

- [Интерфейс обращается к своему origin](same-origin-transport.md)
- [Окно приложения: профили, защита, меню, сборка и установка](desktop-window.md)
- [Кнопки окна в топбаре: системный overlay, свободное место и перетаскивание](desktop-titlebar.md)
- [Иконка окна: отдельный сглаженный растр для панели задач](desktop-window-icon.md)
- [Старт окна: заставка, свой сервер, ворота показа, сроки и единый выход](desktop-startup.md)
- [Общие настройки: native-команда и совместимость прежнего адреса](desktop-settings-window.md)
- [Несколько окон Electron: UA не наследуется, window.close, связь документов](electron-windows-behavior.md)
- [Скрытое окно Electron: ready-to-show на каждый документ, модальность при скрытом родителе, выход](electron-hidden-window-startup.md)
- [Окружение потомков Electron и AppImage: APPDIR в путях, CHROME_DESKTOP, IPC с системным node](electron-child-environment.md)

- [Подсказки: богатая справка, строковая директива, лента без справки и сторож title](tooltips.md)
- [Оповещения: тост в окне и системный канал в фоне](in-app-alerts.md)

- [Веб (web/src/)](frontend-architecture.md)
- [Установка плагинов: граница браузерного API](plugin-install-ui.md)
- [Диалог установки из Git: шаги, стабильная загрузка, просмотр пакета и карточка источника](plugin-install-flow.md)
- [Окно установки: постоянные места действий, ошибки без сдвига формы и переходы между шагами](plugin-install-layout.md)
- [Клиент 3D: durable browser intentions, постоянная SSE и защита поздних ответов](studio3d-window.md)
- [Панель 3D: постоянный ToolHost, скрытие viewer, проверка скелета и тексты](studio3d-tool-lifecycle.md)
- [Дизайн 3D: подписанные вкладки, блоки формы, постоянная стоимость и адаптив по ширине панели](studio3d-layout.md)
- [Сценарии 3D: от исходника до проекта, сохранение черновика и приоритет проблемных заказов](studio3d-user-journeys.md)
- [Рабочая область 3D: компактный холст, инструменты вида, версии и инспектор](studio3d-workspace.md)
- [Библиотека 3D: дерево версий, сохранение с SHA и рабочая папка агента](studio3d-models.md)
- [Задачи 3D: childId, ручной разбор unknown и честная недельная сводка](studio3d-tasks.md)
- [Настоящий 3D viewer: parsers, animation, compare, bounded ресурсы и dispose](studio3d-viewer.md)
- [Исправление фризов: функциональные проверки, полная серия до/после и остаточные задержки](chat-freeze-fix-results.md)
- [Чаты на отдельном полном сервере: production UI, SSE, запись, reload и архив](chat-runtime-smoke-check.md)
- [История чата: Blob уменьшает синхронную стоимость передачи большого JSON в fetch](chat-history-request-body.md)
- [Настройки исполнителей раскрываются по одному](executor-settings-accordion.md)
- [Панель MCP: компонент отображения, реактивный снимок и загрузка страницы](provider-mcp-panel.md)
- [Дополнительные настройки: доступные действия и скрытые недоступные параметры](native-settings-form.md)
- [Состояние дополнительных настроек видно у поля](native-settings-states.md)
- [Область дополнительных настроек и карточка встроенного runtime с причиной недоступности](native-settings-scope.md)
- [Длинные списки строк рисует окно VirtualRows: порог, замер шага и поводы пересчёта](virtual-rows.md)
- [Вид — третичный уровень без заголовка](view-navigation-level.md)
- [Горячие клавиши инструментов — настройка устройства](device-tool-shortcuts.md)
- [Звонят все три беды вотчера, а не две](watcher-alert-sounds.md)
- [Проект — главный уровень панели](project-navigation-level.md)
- [Пропорции страницы «Чаты» — тоже настройка устройства](chat-layout-preferences.md)
- [Выбор рабочей папки чата: иконки, строки вариантов и узкий экран](chat-workdir-picker.md)
- [Рабочая сводка топбара остаётся короткой](topbar-summary.md)
- [Общие плитки топбара: стык с индикатором, геометрия и переключение](topbar-panels.md)
- [Текст метрик и IP на общей оси топбара](topbar-status-alignment.md)
- [Вертикальная центровка топбара: нижняя линия и значки разной высоты](topbar-vertical-axis.md)
- [Разделители топбара: тонкие линии и одинаковые отступы](topbar-separators.md)
- [Нормализация видимой высоты знаков исполнителей и двухцветный Tripo](provider-icon-height.md)
- [Размер знаков 14 px у Codex и Claude, 13 px у остальных; точка обновления у рисунка](topbar-provider-badge.md)
- [Сглаживание маленьких SVG: дробные координаты и плотность экрана](provider-icon-rasterization.md)
- [Горизонтальная привязка знаков к физическим пикселям без увеличения размеров](provider-icon-pixel-snap.md)
- [Прогноз лимитов во всплывашке показывает темп без истории сбросов](usage-forecast-reset-row.md)
- [Размеры раскладки — настройка УСТРОЙСТВА](device-layout-preferences.md)
- [Скругления: два общих токена и отдельные значения в компонентах](corner-radius.md)
- [Состояние — второй, визуально тихий уровень в той же строке](status-navigation-level.md)
- [Фильтры доски адаптируются по ширине самой карточки, а не viewport](board-filter-container-width.md)
- [Цветные числа обеих реек: один счётчик внимания, причины и предел 999+](navigation-counts.md)
- [Счётчики внимания в навигации](navigation-attention-badges.md)
- [Счётчики боковых панелей: центровка цифр и предел по доступной ширине](sidebar-chip-geometry.md)
- [Пункт «Доска» в сайдбаре: число новых задач без точек состояния](board-sidebar-icon.md)
- [Code, Shelf, Terminal и SSH монтирует только постоянный shared/layout/ToolHost.vue](persistent-tool-host.md)
- [Escape координирует единый typed stack](escape-stack.md)

## Грабли

- [Восстановление настроек после отказа чтения или загрузки](settings-recovery.md)

- [Фризы при перестановке чатов и ответе агента: Markdown всех строк, сравнение истории и старые ленты](chat-update-freezes.md)
- [«Связь теряется при отправках в несколько чатов» = POST держал соединение весь ход](../chat/concurrent-send-transport.md)
- [«GrigDesk завис, все запросы (ожидает)» = съеден лимит соединений браузера](browser-connection-limit.md)
- [Колонка чата без min-width: 0 — длинная команда выталкивает кнопки за экран](chat-column-overflow.md)
- [Scoped-стили страниц настроек](settings-scoped-styles.md)
- [Событие есть на сервере, ветка есть во фронте, а не работает — забыли EVENT_NAMES](sse-event-registration.md)
- [Таймер в state стора + $subscribe = бесконечный круг](store-timer-subscription-loop.md)
- [Интерфейс внутри AppImage: неизменяемые версии, lazy-ресурсы и клавиши](packaged-ui.md)
- [PWA снята: установка приложения и встроенная иконка уведомлений](pwa-installation-requirements.md)
- [Знак GrigDesk: мастера G/GD, растры, генератор и встроенные копии](brand-mark.md)
- [Alt+Shift+клавиша не доходит до страницы: пару забирает переключатель раскладки](keyboard-layout-shortcut-conflict.md)
- [Code/Shelf/Terminal нельзя монтировать отдельно в route и в правом доке](duplicate-tool-mounts.md)
- [Escape закрывает только верхний слой](escape-top-layer.md)
- [Обновление интерфейса установкой пакета](service-worker-cache-refresh.md)
- [Возможности устройства в локальном окне без PWA](pwa-secure-context.md)
- [Tooltip/popover живут в <body>: scoped-селектор consumer-а до surface не дотянется](teleported-overlay-styles.md)

- [settings-search.md](settings-search.md) — поиск метаданных, дерево и показ поля настроек.

- [settings-preferences.md](settings-preferences.md) — черновики prefs, клавиш, экрана и диагностики.

- [settings-speech.md](settings-speech.md) — речь, гонки снимков и UI-опрос заданий в общем модале.
