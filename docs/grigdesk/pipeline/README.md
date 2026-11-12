# Конвейер

Читай при изменении запуска, маршрутов, графа, остановок, триажа и арбитра.

Фабрика и движок маршрутов, граф попытки, ворота, арбитр и триаж.

Читай перед правкой: `engine`, `server/src/modules/factory`, `server/src/modules/routes`, `web/src/views/pipeline`, `web/src/views/routes`.

## Контракты продукта

- [Схема конвейера](../guide/pipelines.md)
- [Редактор маршрутов](../guide/routes.md)
- [Где конвейер спрашивает человека](../guide/gates.md)
- [Задача: постановка и триаж](../guide/tasks.md)

- [Восстановление сохранённого перехода](pending-transition-recovery.md) — host receipt, runtime gap, exact human projection и журнал для карточки.

## Устройство

- [Закрепление доступа цепочек исполнителей, identity попытки, паузы и рестарт](access-profile-pins.md)

- [Достоверность приёмки: поздние блокеры, обязательные доказательства и автоматические цепочки](acceptance-evidence.md)
- [Подтверждённый источник запуска и совместимая выдача конвейера](task-source-index.md)
- [Codex: отсутствие terminal status, noResult, stage-result и пояснение skipped](codex-no-result-contract.md)
- [Offline-граница DeepSeek: metadata как provider, код 126 и denylist](deepseek-offline-guard.md)
- [Браузер этапа: pinned authority, CLI/MCP, lifecycle и поставка](browser-transport.md)
- [Как усиливать узлы конвейера](node-hardening.md) — входы и результаты, PLAN/SKEPTIC,
  доказательства проверок, повторы, границы GLM и безопасная публикация.

- [Арбитр: приём итогов модели, чистые реплики и ручной повтор](arbiter-result-recovery.md)
- [Остановка арбитра кнопкой и перед продолжением прогона](arbiter-cancellation.md)
- [Ручная остановка конвейера — не сбой](manual-stop-vs-crash.md) — метка
  `STOPPED_SIGNAL` в реестре: остановка кнопкой не звонит «Конвейер оборвался».
- [Арбитр: учёт ответов, короткое продолжение, пустые вопросы и следующий шаг](arbiter-dialog-progress.md)
- [GLM: обязательные артефакты state-only и граница записи STATE_DIR](glm-state-artifacts.md)
- [Массовый запуск и остановка: области, гейты и блокировка повторов](bulk-run-controls.md)
- [Выбор модели триажа и профили доступа Codex](triage-model-selection.md)
- [Триаж GLM, Kimi и DeepSeek: файловый брокер и проверка инструментов](triage-executors.md)
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
- [Несовместимость поставки раннера](runner-supply-incompatibility.md) — строгий маркер,
  покрытие всех недоступных кандидатов и одна перепривязка рантайма на resume.
- [Ручная перепривязка рантайма](runtime-rebind.md) — кнопка в диалоге этапа снимает
  закрепление остановленной попытки: следующий запуск берёт текущую поставку сервера.
- [Отказ среды не повторяется](environment-failure-stop.md) — failed/environment
  останавливает узел сразу: причина в комментарии и строке остановки, решение у человека.

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
- [Данные фабрики](factory-data.md)
- [разбор СОХРАНЯЕТСЯ и виден в карточке остановки](persistent-stall-analysis.md)

### Клиент графа

- [Изоляция действий узла и сохранение исполнителя после закрытия окна](node-action-isolation.md)
- [Окно узла по образцу задачи: служебная шапка, название, сведения и вкладки](node-dialog-task-layout.md)
- [Телефон: граф со стрелками, масштаб, обзор и переход к текущему этапу](phone-graph.md)
- [Телефон: фильтры, управление и подвал вокруг прежней схемы](../web/phone-pipeline-controls.md)
- [Загрузка действия карточки: один спиннер и блокировка соседних кнопок](card-action-loading.md)
- [Чтение плана: единая область, меню оглавления, переходы и плотность текста](stage-document-reader.md)
- [Одинаковая высота главного и вторичных действий карточки](card-action-height.md)
- [Подвал карточки: адреса стенда слева, компактные действия справа](card-footer-layout.md)
- [GLM: единое имя модели, действия wrapper-а и конкретная причина отказа](glm-runner-display.md)
- [Компактные controls окна узла: список без повторных пояснений и источники в подсказках](node-dialog-controls.md)
- [Окно узла: вкладки, действия и черновик параметров исполнителей](node-dialog-design.md)
- [Обсуждение с арбитром: компактное подключение, источник, авторы реплик и ожидание](arbiter-conversation-design.md)
- [Вкладка «Арбитр» — дополнение окна этапа: результат с причиной и возвратом всегда главная](stage-arbiter-tab.md)
- [Ответы арбитру: вертикальные варианты, зелёная рекомендация и отдельное поле ответа](arbiter-question-choices.md)
- [Исполнители: заголовок карточки без плашки цепочки, сведения в узле и окне этапа](card-runner-details.md)
- [Одна панель остановки: полки, метки, узкий экран и совместимость DTO](stall-panel.md)
- [Раскрытие подробностей сохраняется при обновлении карточки](stop-disclosure-state.md)
- [Старый формат узлов живого графа](live-graph-legacy-nodes.md)
- [Петля агентов: круг, этап и видимая передача между ведущим и исполнителем](loop-visualization.md)
- [Runtime петли: изолированный стенд, финальные команды и ограничения передач](route-loop-runtime-constraints.md)
- [Работа узла: вращающаяся обводка и синяя стрелка текущего возврата](running-node-outline.md)
- [Выбор исполнителя на отдельной вкладке без закрытия окна](node-executor-selection.md)
- [Документ этапа: карта NODE_DOC и список сервера обязаны сходиться](stage-document-mapping.md)
- [Шапка документа: верхний отступ без щели при прокрутке](stage-document-sticky-header.md)
- [Клиент (web/src/shared/graphGeom.ts)](graph-client.md)
- [Импорт общего API из вложенных компонентов конвейера](client-api-imports.md)
- [Модель и effort в модалке узла](node-model-and-effort.md) — сохранение по клику без «Применить»,
  проекция настройки в граф, exact API, scoped storage, отказ каталога и receipt перезапуска.
- [Область настройки этапа](stage-runner-settings-scope.md) — локальный выбор и оба режима живого этапа.
- [Предыдущая раскладка и причины разделения содержимого и решения](stage-dialog-layout.md)
- [Текст человека в модалке: у ворот и у возврата он разный](gate-and-rewind-comments.md)
- [Токены попытки: meta.env — зеркало, а не источник правды](attempt-token-accounting.md)

## Грабли

- [Изолированный стенд пуст: приёмка редактора упирается в отсутствие данных](stand-empty-editor-acceptance.md)
- [Browser run stale до первого запроса: umask, права control и стартовый барьер](browser-launch-permissions.md)
- [Арбитр: текст разбора сохранён, но ошибка формата итога убрала варианты решения](arbiter-result-format-failure.md)
- [Арбитр требует отсутствующий plan: запуск использует режим «Авто»](arbiter-auto-mode.md)
- [Составной modelRef GLM требует представления маршрут/модель в lifecycle](lifecycle-model-id.md)
- [Повтор INSTRUMENT после временного отказа упирался в завершённую транзакцию](instrumentation-retry.md)
- [Codex на SHIP: native Auto-review, защищённый Git и границы сдачи](codex-delivery-permissions.md)
- [«SHIP опять вернул решение человеку», а попытка Codex завершилась ok = публикация и не могла случиться: песочница Codex не пишет `.git`; доставка собирается временным клоном, перемотка `dev` — три команды человека](codex-delivery-permissions.md)
- [«Продолжить» после failed: остановка ждёт goto без побочных эффектов](failed-resume.md)
- [Подключение раннера: неявный effort, статус, fanout и host-диагностика](runner-extension-boundaries.md)
- [Не все исполнители видны в узле: допуск редактора, прежняя цепочка аварийного переключения и граница GLM](runner-selection-boundaries.md)
- [«Агент пишет» над намертво вставшим агентом = свежесть журнала считали по mtime](agent-activity-freshness.md)
- [«Блокирующее замечание» проверяющего узла бывает просто отказом прав](reviewer-permission-denials.md)
- [«Завис — агент молчит», «узел вернул решение человеку» и «исчерпан бюджет повторов» в одной модалке = три захода убиты по лимиту, а туннель терял половину рукопожатий](retry-timeouts-and-tunnel-failures.md)
- [Ошибки всех исполнителей: распознанная причина, запасной stderr и отсутствие диагностики](runner-failure-diagnostics.md)
- [Имя CLI в команде раннера подставляет helper, а не args: сдвоенное имя = отказ до модели](runner-external-cli-launch.md)
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
- [Контракт каталога ролей, подготовки и атомарной вставки этапа](stage-wizard.md)
- [Ответы мастера о правах и проблемах этапа](stage-wizard-answers.md)
- [Где конвейер спрашивает человека — подробный контракт](human-gates.md)
- [Схема конвейера — подробный контракт](graph-rendering.md)
- [Редактор маршрутов: черновики через плюс, публикация и откат](route-editor.md)
- [Задача: постановка и триаж — подробный контракт](task-triage.md)

## История решений

- [История: Вердикт human и история отдельной модалки](human-verdict-dialog.md)
- [История: вердикт human закрывает автоматический повтор по этой остановке](human-verdict-retry-boundary.md)
- [История: границу задачи арбитр менять не вправе](arbiter-task-scope.md)
- [История: решение о границе задачи больше не останавливает конвейер, если у развилки есть минимальный вариант](minimal-scope-default.md)
- [История: что решено за человека, показывают ВОРОТА](gate-decision-transparency.md)
- [История: Разбор и решение внутри окна проблемного этапа](human-decision-dialog.md)
- [История: «Арбитр не сработал» на остановке human — так и задумано, но карточка об этом молчала](human-stall-arbitration.md)
- [История: «Арбитр помер» = он отработал, а показать результат было негде](arbiter-result-visibility.md)
- [История: «Встал на самом старте» на маршруте без плана = новый вопрос повторного триажа](planless-route-open-question.md)
- [История: Вотчер арбитра молчал и когда брался за задачу, и когда отдавал её человеку](arbiter-watcher-notifications.md)
- [История: Самая частая остановка маршрута была невидимой и неразбираемой](stall-visibility-and-analysis.md)
