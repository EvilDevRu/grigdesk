# Протокол портала

- Полная сводка дашборда приходит из `/local/ajax/dashboard.php?action=getData`;
  быстрые данные за сегодня — из `action=getTodayData`. Месячные итоги берутся из
  `data.mainData`: `worked_hours`, `min_hours`, `completed_tasks`, `min_tasks`.
  **`completed_tasks` — не число закрытых задач.** Это число разных задач с учтённым
  временем за месяц: оно равно `completedTasksList.length` и месячному `chartData.tasks`
  и включает незакрытые задачи. На странице `/salary/` портал показывает его как
  «Выполненные задачи (месяц)» с нормой `min_tasks` — это KPI мотивации, а не статусы.
  Реальное число закрытых за месяц даёт только `tasks.task.list` (session-AJAX
  `/bitrix/services/main/ajax.php?action=tasks.task.list`, страницы `nav=page-N-size-50`)
  с фильтром `>=CLOSED_DATE`/`<=CLOSED_DATE` и `RESPONSIBLE_ID`; у статуса 4
  «ждёт контроля» `CLOSED_DATE` тоже заполнена. Месяц у `getData` выбирается
  `periods[]=M-YYYY`; `chart_period` и `show_all_tasks` на `mainData` не влияют.
  Ряд `chartData.day.tasks` суммировать нельзя: одна задача учитывается в нескольких
  днях. Графики day/week/month извлекаются из `chartDataByPeriod` в HTML `/salary/`.
- `getTaskDetails` не отдаёт вложения и комментарии. Они парсятся из HTML страницы задачи:
  файлы — из `#task-detail-files`, комментарии — из блоков `record-TASK_*`; системные
  комментарии помечены `mpl-comment-aux`.
- Ростер приходит через `getAvailableUsers`, поиск по имени выполняется локально по всем
  токенам запроса.
- Проекты для селекта задачи приходят через сессионный
  `socialnetwork.api.workgroup.list`: только активные и неархивные, по 50 элементов
  с навигацией `nav=page-N-size-50`. Результат кешируется на время жизни `B24Client`;
  форма показывает человеку имя, а сохраняет числовой `groupId`.
- Создание использует `tasks.task.add` и form-urlencoded поля. Проверка `priority !== null`
  принципиальна: нулевой приоритет валиден.
- Редактирование использует `tasks.task.update` и передаёт только явно изменённые поля.
  Для снятия проекта в `fields[GROUP_ID]` уходит `0`; пустое описание передаётся буквально,
  а не пропускается. CSRF-ретрай повторяет только update-запрос.
- Файлы загружаются сырыми чанками до 10 МБ через `ui.fileuploader.upload` и
  `disk.uf.integration.diskUploaderController`. `serverFileId` вида `n<objectId>` идёт в
  `UF_TASK_WEBDAV_FILES` задачи либо `UF_FORUM_MESSAGE_DOC` комментария.
- Комментарий отправляется через `bitrix:forum.comments` с `signedParameters` со страницы
  задачи. Текст обязателен даже при наличии вложения; комментарий уведомляет участников.
- Таймер использует `/local/ajax/task_timer.php` с действиями `start`, `pause`, `stop`.
- `complete` сначала явно останавливает таймер и только затем вызывает
  `tasks.task.complete`: портальный автостоп ненадёжен и может не записать время в журнал.
- На сданной или завершённой задаче перед запуском таймера нужен `tasks.task.renew`.
  Без renew портал может вернуть старый `started_at`, хотя таймер реально не идёт.
- Публичные ссылки Яндекс.Диска разрешаются через cloud-api; прямые изображения
  скачиваются. Закрытые Telegram-ссылки и видео этим путём не загружаются.
