# Установка плагинов: граница браузерного API

`shared/pluginInstall.ts` содержит чистые подписи результата, этапы и progress.
Измеримый процент относится только к скачиванию Git; установка зависимостей и
применение показываются без процента. Recovery не означает успешно законченный job.
Rollback имеет отдельный текст восстановления версии. Badge перезапуска приоритетнее
доступного обновления.

`shared/pluginInstallApi.ts` превращает unknown JSON в проверенный публичный DTO.
Он заново строит поля job, source, target, preview, изменений и install info; unknown
поля не выпускаются. Проверяются UUID, safe integer revision, стабильная версия,
SHA/digests, UTC даты и согласованность preview с job. Ready/applying/done требуют
полного preview и reviewToken, а terminal требует finishedAt. BackupRef — basename
с plugin id, датой и UUID, без пути к файлу.

Некорректный HTTP200/202 вызывает PluginInstallProtocolError до публикации карточки.
Previous в InstallInfo содержит весь snapshot, в том числе прежний источник и digest.
Optional install, отсутствующий у старого сервера, поддерживается; null означает
ручную установку. Current хранит recoveryError отдельно даже при job:null.

Проверки: `plugin-install-labels.test.js` и `plugin-install-api.test.js`. Сценарии
охватывают все статусы/виды job, повреждённые nested поля и успешный HTTP с невалидной
capability; прежний проверенный snapshot при отказе сохраняется.

## Store и потерянные ответы

`stores/pluginInstall.ts` владеет одним timeout и одним polling request на экземпляр
Pinia. Таймер, controllers и epochs находятся вне reactive state. Закрытие диалога
не останавливает job; `$dispose` отменяет свои HTTP reads и запрещает поздним ответам
публиковаться или очищать сохранённый rollback intent. Ошибки polling видны, backoff
растёт до10с, успешный read возвращает1с.401/403 прекращают polling.

Поиск хранит исходный trim URL как input key, а канонический source URL отдельно.
Смена ввода инвалидирует список; поздний ответ прежнего поиска игнорируется. Ревизия
job и epoch защищают от GET до более новой мутации. Done обновляет каталог ровно
один раз на пару job id/revision.

Перед apply сохраняется исходный job id и reviewToken. Pending action закрывает
повторные кнопки ещё до HTTP ответа. При обрыве или5xx читается именно этот id,
а не current другого задания. Read не повторяет apply. Если история вытеснена,
показывается недоступность результата, обновляется каталог, исход остаётся неизвестным.

Rollback сохраняет UUID, baseline revision и previous payloadDigest в sessionStorage
до POST. После пересоздания store replay использует тот же body и серверный receipt.
Известный409 снимает прежнее намерение; новый UUID автоматически не создаётся.
Malformed stored intent и current response блокируют новые мутации. Health остаётся
видимой даже при пустом job.

Непрочитанный terminal показывается после повторного открытия. Только явный forget
отмечает его id/revision в sessionStorage, active/ready/recovery забывать нельзя.
Новая ревизия старой операции остаётся видимой. Проверка store —24 сценария
`plugin-install-store.test.js`, включая barriers сети, fake clock и два Pinia instances.

## Диалог

`PluginInstallDialog.vue` использует реальные UI primitives. При открытии сначала
читает сохранённое задание; фактический job определяет заголовок и источник, даже
если диалог открыт из другой карточки. Непрочитанный terminal показывается как итог.
Pending apply и reconciliation имеют приоритет над ready и блокируют новые мутации.
Ошибки и recovery видны во всех ветках. Закрытие active/ready не отменяет работу;
явная отмена вызывает store.cancel. Ready содержит полный SHA, источник, предупреждения
и ограниченный diff. Двойной click проверяет живую занятость до отправки.

Проверка —23 сценария `plugin-install-dialog.component.test.js`: настоящие controls,
барьер bootstrap после unmount, поздний terminal, потерянный apply и recovery без job,
повтор чтения current, стабильные поля поиска и возврат к обновлению после ошибки,
завершённая полоса шагов, прокрутка и закрытие через постоянную шапку.
Раскладка и состояния загрузки описаны в [диалоге установки из Git](plugin-install-flow.md).

## Панель источника и каталог

`PluginSourcePanel.vue` стоит в карточке каждого user plugin, даже без параметров.
Она показывает source/version, check outcome, local changes, previous и причины
недоступного отката. Реальный общий confirm host подтверждает rollback; guard
проверяется и после await. Двойной click, recovery во время confirm и unmount
не разрешают новый intent. При неизвестном исходе доступно явное reconciliation.

`pages/PluginPage.vue` читает current/health при монтировании, добавляет install/check
и badges с приоритетом restart. Действия update/bind открывают прежний wizard поверх общей формы.
Health блокирует изменения, сохраняя системные элементы списка и объяснение; job recovery
показывается и без отдельного recoveryError. `plugins.load` декодирует optional install
всего ответа до замены списка; невалидный DTO сохраняет прежний каталог целиком.

Проверки — P1–P8 с настоящим dialog host, K1–K6, включая настоящие Pinia installer
и каталог: done перечитывает список один раз, новый id выключен, prefs сохранены.
