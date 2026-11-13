# Источники месячной квоты QwenCloud Token Plan

Проверено 13 ноября 2026 года по официальной документации, публичному коду кабинета
QwenCloud `console-home/1.1.65` и исходникам QwenCloud CLI на commit
`264999e87d2fe819a9c570a9f3cbc1c9864a5163`. Это исследование внешнего контракта:
получение квот в GrigDesk пока не реализовано, живой ответ аккаунта не проверен.

## Что означает квота

Token Plan Individual учитывает расход в Credits. Месяц привязан к подписке, а не
к первому числу календарного месяца. Credit Packs дают отдельный дополнительный
остаток; он не увеличивает месячную квоту. Размеры планов меняются у поставщика,
поэтому число из таблицы тарифов не является постоянной ёмкостью окна.

Источники: [FAQ Individual](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-faq),
[обзор Token Plan](https://docs.qwencloud.com/token-plan/overview).

## Официальный CLI и доступ

QwenCloud CLI (`@qwencloud/qwencloud-cli`) — отдельная программа от Qwen Code.
Документирована команда `qwencloud usage summary --format json`: раздел `token_plan`
может содержать `totalCredits`, `remainingCredits`, `usedPct`, `resetDate`.
Управляющие команды используют отдельный вход `qwencloud auth login`; ключ вызова
моделей не заменяет этот вход. Для интерфейса без терминала предусмотрены
`auth login --init-only --format json` и `auth login --complete`.

[Документация CLI](https://docs.qwencloud.com/api-reference/preparation/cli).

Проверенный `src/services/tokenplan-service.ts` имеет ограничения:

- При `QuerySubscriptionGray.IsGray` читает `GetSeatSubscriptionSummary` для Team.
- В legacy-ветке читает `DescribeFrInstances`, объединяет Team и Personal, выбирает
  первую действующую подписку; `buildTokenPlanDto` не заполняет дату сброса.
- При ошибках возвращает `subscribed: false` или пропускает отказавшую часть данных.

Следовательно, успешный exit CLI и отсутствие подписки в его JSON ещё не подтверждают
отсутствие месячной квоты Individual. Нельзя считать такой результат готовым контрактом
для полосы без сверки с кабинетом.

[Проверенные исходники CLI](https://github.com/QwenCloud/qwencloud-cli/blob/264999e87d2fe819a9c570a9f3cbc1c9864a5163/src/services/tokenplan-service.ts).

## Источник полосы в кабинете Individual

Публичный модуль `analytics.js` объявляет следующие значения параметра `Api`
шлюза `sfm_bailian`; это внутренние имена, а не самостоятельные публичные HTTP URL:

| Значение `Api` | Назначение |
|---|---|
| `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription` | Подписка, включая `specCode`; параметр `commodityCode` для международного Individual — `sfm_tokenplansolo_public_intl` |
| `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` | Расход окна и сброс; `Data: {}` |
| `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config` | Ёмкость окон по коду плана; `Data: {}` |
| `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/list` | Дополнительные Credit Packs, фильтр `ACTIVE` |

Полоса берёт `per1MonthPercentage` как **израсходованную долю 0…1**, а
`per1MonthResetTime` — как время сброса в миллисекундах. Остаток в процентах равен
`(1 - per1MonthPercentage) * 100`. В текущем коде также сохранена совместимость с
`per1WeekPercentage`/`per1WeekResetTime`: при наличии недельного поля используется оно.
Размер месячной квоты берётся из результата `quota-config` по `specCode` подписки.

Шлюз кабинета в `shared.js` отправляет запросы на `/data/api.json` с cookies и
`sec_token`; QwenCloud CLI использует свой gateway с Bearer access token управляющей
сессии. Возможность вызвать новые Individual-методы через gateway CLI требует живой
проверки. Приём модельного API-ключа этими методами не подтверждён.

Источники: [модуль аналитики кабинета](https://q.alcasset.com/code/qwen-cloud/console-home/1.1.65/assets/analytics.js),
[общий транспорт кабинета](https://q.alcasset.com/code/qwen-cloud/console-home/1.1.65/assets/shared.js).
Внутренние методы кабинета не имеют обещания совместимости публичного API.

## Существующая граница GrigDesk

`server/src/lib/executors/qwen.ts:usage` сейчас возвращает `unsupported`.
Общий `UsageBar` уже содержит `pct` расхода и `resetsAt`, а ресурсы позволяют отдельно
показывать числовой остаток и сведения о плане. DeepSeek использует ту же границу,
но получает денежный баланс через `GET /user/balance`, а не месячное окно.

Политика [обновления квот](usage-refresh-policy.md) уже задаёт ручную ↻, общую
автоматику, сохранение устаревшего снимка при ошибке и смену поколения аккаунта.
Месячное окно не требует выдуманной постоянной длительности —
[контракт подписей](usage-window-labels.md).

На этой проверке использованы только публичные документы и исходники. Вход в аккаунт,
запрос его квот и сопоставление с текущим API-ключом не выполнялись. Пользовательское
поведение и справка GrigDesk остаются прежними.
