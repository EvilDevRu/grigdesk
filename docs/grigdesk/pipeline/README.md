# Конвейер

- [Codex: rc=0 без terminal status, noResult маршрута и stage-result](codex-no-result-contract.md)

- [Offline-граница DeepSeek: metadata как provider, код 126 и denylist](deepseek-offline-guard.md)

Фабрика и движок маршрутов, граф попытки, ворота, арбитр и триаж.

Читай перед правкой: `engine`, `server/src/modules/factory`, `server/src/modules/routes`, `web/src/views/pipeline`, `web/src/views/routes`.

## Контракты продукта

- [Схема конвейера](../guide/pipelines.md)
- [Редактор маршрутов](../guide/routes.md)
- [Где конвейер спрашивает человека](../guide/gates.md)
- [Задача: постановка и триаж](../guide/tasks.md)

## Устройство

- [Образец профиля с тремя маршрутами](profile-sample.md) — единое описание проекта,
  ручное подключение, режим без стенда, командная проверка и способы сдачи.
- [Проверки и доказательства образца](profile-sample-checks.md) — выбор тестов по match
  и отдельная запись приёмки для каждого пункта постановки без явных критериев.
- [Границы короткого маршрута и сдачи](profile-sample-boundaries.md) — поимённые файлы,
  отказ PR в shared, состав приёмки за 15 минут и допустимые исправления ревью.
- [Источник собственной задачи: профиль оценки, арбитр, тикет и название](grigdesk-task-source.md)
- [Сводка конвейера читает собственные названия одним снимком на запрос](task-title-snapshot.md)

- [Профили конвейера: устройство и параметры](project-profiles.md) — файлы, переменные,
  хуки, исполнители и модели, маршруты, значения по умолчанию и применение изменений.
- [Покрытие исполнителей по цепочкам узлов](runner-chain-coverage.md) — схема 2,
  область start/resume, объявленный failover и строгая публикация каталога.

- [Холодный запуск ACP: единый бюджет без повтора initialize](deepseek-acp-startup.md)

- [Упакованные Factory helpers и границы стадий status MCP](../server/server-binary-factory-helpers.md)

- [Бинарный DeepSeek в Factory: descriptor, package coverage, cache и prepared handle](deepseek-binary-factory.md)

- [DeepSeek: canonical prefs, runtime identity и host status каждого узла](deepseek-native-settings-runtime.md)

- [Авто-шип фабрики](automatic-shipping.md)
- [Маршруты (modules/routes)](route-management.md)
- [Палитра](graph-palette.md)
- [Сервер (server/src/lib/factoryGraph.ts)](graph-server.md)
- [Стадии — глобальный enum (server/src/lib/stages.ts)](stage-catalog.md)
- [Триаж называет род работы, глубину маршрута считает политика](triage-routing-policy.md)
- [Триаж сверяет задачу с правилами продукта, соседями и режимами](triage-product-rules.md)
- [Ручной выбор маршрута принадлежит человеку](manual-route-choice.md)
- [Обновление Git перед запуском: общий fetch и профили с локальной базой](launch-git-refresh.md)

### Данные фабрики

- [Диалог разбора остановки: история, явный выбор, CAS и восстановление](arbiter-stop-dialog.md)

- [Результат отдельной разведки: checkpoint, deferred, вопрос и exact ответ](bootstrap-results.md)

- [Вердикт human и история отдельной модалки](human-verdict-dialog.md)
- [вердикт human закрывает автоматический повтор по этой остановке](human-verdict-retry-boundary.md)
- [границу задачи арбитр менять не вправе](arbiter-task-scope.md)
- [Данные фабрики](factory-data.md)
- [разбор СОХРАНЯЕТСЯ и виден в карточке остановки](persistent-stall-analysis.md)
- [решение о границе задачи больше не останавливает конвейер, если у развилки есть минимальный вариант](minimal-scope-default.md)
- [что решено за человека, показывают ВОРОТА](gate-decision-transparency.md)

### Клиент графа

- [Исполнители: заголовок карточки без плашки цепочки, сведения в узле и окне этапа](card-runner-details.md)
- [Одна панель остановки: полки, метки, узкий экран и совместимость DTO](stall-panel.md)
- [Раскрытие подробностей сохраняется при обновлении карточки](stop-disclosure-state.md)

- [Старый формат узлов живого графа](live-graph-legacy-nodes.md)

- [Петля агентов: круг, этап и видимая передача между ведущим и исполнителем](loop-visualization.md)
- [Работа узла: вращающаяся обводка и синяя стрелка текущего возврата](running-node-outline.md)
- [Выбор исполнителя — карточки, и он не закрывает модалку](node-executor-selection.md)
- [Документ этапа: карта NODE_DOC и список сервера обязаны сходиться](stage-document-mapping.md)
- [Клиент (web/src/shared/graphGeom.ts)](graph-client.md)
- [Импорт общего API из вложенных компонентов конвейера](client-api-imports.md)
- [Модель и effort в модалке узла](node-model-and-effort.md)
- [Раскладка модалки: шапка называет этап, колонки отвечают на вопрос](stage-dialog-layout.md)
- [Разбор и решение внутри окна проблемного этапа](human-decision-dialog.md)
- [Текст человека в модалке: у ворот и у возврата он разный](gate-and-rewind-comments.md)
- [Токены попытки: meta.env — зеркало, а не источник правды](attempt-token-accounting.md)

## Грабли

- [Codex на SHIP: native Auto-review, защищённый Git и границы сдачи](codex-delivery-permissions.md)

- [«Продолжить» после failed: остановка ждёт goto без побочных эффектов](failed-resume.md)

- [Подключение раннера: неявный effort, статус, fanout и host-диагностика](runner-extension-boundaries.md)
- [Не все исполнители видны в узле: отдельный каталог раннеров, цепочка живого переключения и граница GLM](runner-selection-boundaries.md)

- [«Агент пишет» над намертво вставшим агентом = свежесть журнала считали по mtime](agent-activity-freshness.md)
- [«Арбитр не сработал» на остановке human — так и задумано, но карточка об этом молчала](human-stall-arbitration.md)
- [«Арбитр помер» = он отработал, а показать результат было негде](arbiter-result-visibility.md)
- [«Блокирующее замечание» проверяющего узла бывает просто отказом прав](reviewer-permission-denials.md)
- [«Встал на самом старте» на маршруте без плана = новый вопрос повторного триажа](planless-route-open-question.md)
- [«Завис — агент молчит», «узел вернул решение человеку» и «исчерпан бюджет повторов» в одной модалке = три захода убиты по лимиту, а туннель терял половину рукопожатий](retry-timeouts-and-tunnel-failures.md)
- [Перегрузка модели и неизвестная ошибка сохраняют конкретную причину в карточке](runner-failure-diagnostics.md)
- [«Конвейер оборвался» сразу после «Принять» = окно передачи хода](gate-handoff-window.md)
- [«Конвейер встал» при живом этапе: правило линейности гасило сам фронт](active-stage-linearity.md)
- [«Маршрут требует файл инструментации» = форма открылась на чужом профиле](launch-profile-consistency.md)
- [«Нет событий N мин» на штатной паузе = свежесть считали по чужому ACTIVE_RUN](active-run-freshness.md)
- [«Ход завис — молчит N мин» сразу после «Продолжить» = молчание считали по журналу убитого хода](dead-runner-silence.md)
- [«Перейти сюда» без пояснения = агент повторит ту же ошибку](rewind-comment-requirement.md)
- [«fail-closed (код 75)» после прогона e2e = сторож state-only поймал runtime-артефакт Playwright](state-only-playwright-artifacts.md)
- [«TESTS: узел вернул решение человеку» при победном отчёте агента = сторож отверг manifest тестов, а сторож отстал от проекта](test-manifest-validation.md)
- [Возврат курсора в зону instrument→proof ломал маршрут насмерть](instrument-proof-rewind.md)
- [Возврат курсора записан, а человек видит отказ: пост-шаг goto ронял решение](rewind-post-action-failure.md)
- [Вотчер арбитра молчал и когда брался за задачу, и когда отдавал её человеку](arbiter-watcher-notifications.md)
- [Доделанный маршрут в виде «✖ оборвалась» = сторож ловил формулировку финала v1](completion-status-detection.md)
- [Жёлтая карточка без единых ворот = доинференс возврата поверх живого курсора](rewind-gate-consistency.md)
- [Задача в UI «замирает»: SSE смотрит не в runtime root](sse-runtime-root.md)
- [Замечание человека доезжало до агента огрызком: две независимые обрезки подряд](human-comment-truncation.md)
- [Запуск фабрики — ТОЛЬКО в отдельный systemd-scope (иначе рестарт GrigDesk убивает прогоны)](factory-systemd-scope.md)
- [Каталог маршрутов сверяется внутри движка, а не в HTTP-preflight](route-catalog-pinning.md)
- [Контракт запуска — по состоянию, не по stdout](launch-state-contract.md)
- [Лёгкий маршрут сужал задачу молча: пустые критерии + «уже есть в коде»](light-route-scope-loss.md)
- [Маршрут встал «код 78» на узле, который отработал = вердикт command-узла не по контракту](command-node-verdict-contract.md)
- [Модалка этапа переживает сам этап — статус в ней обязан идти за графом](stage-dialog-live-status.md)
- [Мутации route attempt требуют exact identity](attempt-mutation-identity.md)
- [Одна остановка, два разных DTO: stall в сводке и stall в графе — не одно и то же](stall-summary-and-graph-contracts.md)
- [Осторожно: проверки окружения гоняются в песочнице с урезанным PATH и сетью](sandbox-environment-checks.md)
- [Отказы человека на приёмке шли с маршрутов, где стенд после сборки не открывал никто](sandbox-acceptance-review.md)
- [Перечитывать по каждому state-change можно только дешёвое](state-change-read-cost.md)
- [Повтор без паузы — не повтор](retry-backoff.md)
- [Поле комментария у ворот обещало доставку, которой при принятии нет](gate-comment-delivery.md)
- [Мелкую поправку к плану вносят в сам план до «Принять», а не комментарием](plan-edit-before-approve.md)
- [Правка репозитория GrigDesk убивает прогон, который в нём же работает](running-checkout-mutations.md)
- [Причина остановки ищется в ОКНЕ текущего захода, а не по всему журналу](current-attempt-stall-diagnosis.md)
- [Проверяющий узел (state-only) не может сравнить файл с HEAD внутри worktree](state-only-worktree-head.md)
- [Проверяющий узел встал `failed` на копии файла: `cp` и `tee` закрыты, а как писать — не сказано](state-only-file-writes.md)
- [Проверяющий, который ведёт этапы, встаёт на третьем проходе: сторож топтания считает этап неснятым замечанием](reviewer-multi-stage-progress.md)
- [Повторное замечание в цикле должно доходить до исполнителя](loop-review-continuation.md)
- [Цикл ведущего и исполнителя: счётчики, findings, отчёты визитов, пределы argv и readers остановок](route-loop-runtime-constraints.md)
- [Ретро оставлял файлы и ничего не менял: генератор предложений без канала решения](retrospective-decision-flow.md)
- [Ромб «Песочница» на графе — статус из реальности, не из цепочки](sandbox-observed-status.md)
- [Самая частая остановка маршрута была невидимой и неразбираемой](stall-visibility-and-analysis.md)
- [Скрипты публикации маршрутов получают схему от сервера (`GRIGDESK_ROUTES_KIT`), а не по относительному пути](route-publisher-typescript-imports.md)
- [Старт route engine из GrigDesk: сервис возвращает 0 всегда, а отказ приходит позже](start-route-engine.md)
- [Подтверждение resume ждёт lifecycle: стоимость чтения и второе окно в 120 секунд](resume-lifecycle-read-cost.md)
- [После перезагрузки «Продолжить» вставало кодом 73: стенд задачи поднимает GrigDesk](stand-restore-on-resume.md)
- [Решение человека записано, а кнопка показала отказ: 30 секунд на синхронный вызов движка](engine-decision-timeout.md)
- [Проверка исполнителей обновляется внутри длинного маршрута](coverage-expiry-during-route.md)
- [Resume читает закреплённый hash каталога из загрузчика попытки](bootstrap-resume-catalog-hash.md)
- [Стенд старой задачи не сносился: попытка родилась раньше lifecycle-журнала](legacy-sandbox-cleanup.md)
- [Первый снос после вопроса человеку: историческая ссылка не открывает визит](human-stop-cleanup.md)
- [Транзакционный узел БЕЗ пары instrument делает маршрут заложником формы запуска](transactional-node-instrument-pair.md)
- [«Триаж читает старый код» при включённом обновлении = рабочая копия стояла не на master](triage-source-snapshot.md)
- [Узлы маршрута обязаны ходить в общий runtime под ОДНИМ uid](shared-runtime-uid.md)
- [Command-узел тянет за собой артефакт своего узла-источника](command-node-source-artifacts.md)
- [plan не песочница от записи, а арбитру десяти минут не хватало](plan-permissions-and-arbiter-timeout.md)
- [ttNNNN.pipeline — призраки](legacy-pipeline-artifacts.md)
- [VERIFY встал «ESLint не стартовал: No files matching the pattern» = в diff удалённый файл, статика линтовала его](eslint-deleted-file-filter.md)
- [VERIFY дважды вернул исправную сборку: помощник теста ушёл в Pest как тест](verify-test-helper-targets.md)
