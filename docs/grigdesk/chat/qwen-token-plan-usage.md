# Источники квот для подключений Qwen Code

Источники QwenCloud Token Plan начально проверены 13 ноября 2026 года.
27 ноября сверены другие подключения и отдельная команда статуса QwenCloud CLI.
Исследование опирается на публичные документы и исходники.

## Что означает квота

Token Plan Individual учитывает расход в Credits. Месяц привязан к подписке, а не
к первому числу календарного месяца. Credit Packs дают отдельный дополнительный
остаток; он не увеличивает месячную квоту. Размеры планов меняются у поставщика,
поэтому число из таблицы тарифов не является постоянной ёмкостью окна.

Источники: [FAQ Individual](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-faq),
[обзор Token Plan](https://docs.qwencloud.com/token-plan/overview).

## Официальный CLI и доступ

QwenCloud CLI (`@qwencloud/qwencloud-cli`) — отдельная программа от Qwen Code.
Управляющие команды используют отдельный вход `qwencloud auth login`; ключ вызова
моделей не заменяет этот вход. Для интерфейса без терминала предусмотрены
`auth login --init-only --format json` и `auth login --complete`.

`qwencloud subscription tokenplan status --edition individual --format json` читает
подписку, квоту и расход через управляющую сессию. Для действующего Individual
`individual.tiers[]` содержит вид окна, `usedPct`, `remainingPct`, `resetAt` и, при
успешном чтении конфигурации, `totalCredits`. В проверенном исходнике
`remainingCredits` у Individual равен `null`. Для полосы подходит доля расхода.
`--edition team` возвращает сведения о местах и агрегаты. Чтобы показать лимит
конкретного ключа Team, нужно подтвердить его соответствие месту, чей расход виден.
`endAt` — конец подписки, `resetAt` — сброс квоты. Пустые или частичные данные не равны
нулевому остатку.

[Документация CLI](https://docs.qwencloud.com/api-reference/preparation/cli#subscription-tokenplan-status),
[реализация статуса Individual](https://github.com/QwenCloud/qwencloud-cli/blob/17cb839fe9726b33ece40bd7a679eec8f9d8c95f/src/services/tokenplan-individual.ts#L292).

Общая команда `qwencloud usage summary --format json` документирует раздел `token_plan`
с `totalCredits`, `remainingCredits`, `usedPct`, `resetDate`. При проверке ранее
закреплённого `src/services/tokenplan-service.ts` обнаружились ограничения:

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

## Другие подключения Qwen Code

| Подключение | Источник | Показания |
| --- | --- | --- |
| QwenCloud PAYG | `qwencloud usage free-tier --format json`, `qwencloud usage payg --format json` после входа в QwenCloud CLI | Бесплатный остаток по моделям и отдельно платный расход за период |
| Alibaba Model Studio PAYG | Bailian CLI `bl usage free --model <id> --output json` с доступом к консоли Alibaba Cloud | Пробные токены выбранной модели и срок действия. Для международного сайта пробная квота предоставляется поддерживаемым моделям Сингапура с областью `International` |
| Alibaba Coding Plan | Bailian CLI `bl usage coding-plan --output json` с доступом к консоли Alibaba Cloud | Использованные и доступные запросы, момент сброса окон 5 часов, недели и расчётного месяца. CLI различает международный и китайский продукты по сайту консоли |
| OpenRouter | `GET /api/v1/key` с подключённым ключом | Расход, остаток денежного лимита ключа, период сброса и суточный лимит бесплатных запросов, если поля есть в ответе |

Для Alibaba отдельный `QueryAccountBalance` BSS OpenAPI читает денежный баланс всего
аккаунта с правом на биллинг. Для баланса аккаунта OpenRouter используется
`GET /api/v1/credits` с Management Key. Оба баланса имеют собственную область и не
показывают остаток лимита конкретного модельного ключа. Пробная квота имеет срок
истечения, а RPM/TPM характеризуют пропускную способность модели.

Источники: [QwenCloud CLI](https://docs.qwencloud.com/api-reference/preparation/cli#usage-free-tier),
[команды Bailian CLI](https://www.alibabacloud.com/help/en/model-studio/cli/usage-quota),
[авторизация Bailian CLI](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/cli/installation),
[код квот Coding Plan](https://github.com/modelstudioai/cli/blob/b72d0b047388c365c2fad0e5810150a59303944e/packages/commands/src/commands/usage/coding-plan.ts),
[пробная квота Model Studio](https://www.alibabacloud.com/help/en/model-studio/new-free-quota),
[Alibaba BSS OpenAPI](https://www.alibabacloud.com/help/en/user-center/developer-reference/api-overview-1),
[лимит ключа OpenRouter](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key),
[баланс OpenRouter](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

## Поставки утилит для чтения квот

Проверено 27 ноября 2026 года. [QwenCloud CLI v1.7.0](https://github.com/QwenCloud/qwencloud-cli/releases/tag/v1.7.0)
публикует `qwencloud-linux-x64.zip` и `checksums.txt`,
[Bailian CLI v2.12.0](https://github.com/modelstudioai/cli/releases/tag/v2.12.0) —
`bl-2.12.0-linux-x64.tar.gz` и `SHA256SUMS`. Обе поставки доступны отдельно от
архива Qwen Code. Сверены SHA-256 обоих архивов с метаданными релизов и заголовки ELF
файлов `qwencloud` и `bl-2.12.0-linux-x64` внутри них. OpenRouter читает данные ключа по HTTP.

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
