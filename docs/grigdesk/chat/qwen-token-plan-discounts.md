# Ночные акции QwenCloud Token Plan

27 ноября 2026 года проверены [публичная витрина Token Plan](https://www.qwencloud.com/benefits/tokenplan),
[модуль её таблицы моделей](https://q.alcasset.com/npm/@ali/hmod-qwencloud-token-plan-model-list-table/0.0.2/index.js)
и [модуль кабинета](https://q.alcasset.com/code/qwen-cloud/console-home/1.1.73/assets/shared.js).
Витрина и кабинет запрашивают один и тот же список `listTokenPlanModels` для выбранного вида подписки.

## Получение данных

Витрина отправляет `POST` на `https://ap-southeast-1-cs-data.qwencloud.com/data/api.json`.
Параметры шлюза: `product=sfm_bailian`, `action=IntlBroadScopeAspnGateway`,
`api=zeldaHttp.dashscopeModel./zelda/api/v1/modelCenter/listTokenPlanModels`.
Форма передаёт `region=ap-southeast-1`, `params.Api` с именем метода и
`params.Data.input` с `pageNo: 1`, `pageSize: 100` и `edition: PERSONAL` или `TEAM`.
В `params.Data.cornerstoneParam` витрина указывает `consoleSite: QWENCLOUD`,
`domain: www.qwencloud.com`, `productCode: p_efm`, `protocol: V2` и `xsp_lang`.
Проверка с пустым `sec_token`, без cookies и без ключа модели вернула HTTP 200 и
списки из 24 моделей Individual и 33 моделей Team. Это интерфейс витрины без
опубликованного контракта совместимости.

В `data.DataV2.data.data.list` у модели есть `modelId`, `badgeLabel` и `badgeDescription`.
Список промо зависит от переданного `edition`. Поля бейджа содержат тексты на выбранном
языке. В проверенных строках часы даны в описании, а отдельных полей часового пояса,
коэффициента списания и срока действия акции нет.

## Что показывает источник

| Модели | Individual | Team |
| --- | --- | --- |
| `auto` | `40% Off Nights` | `40% Off Nights` |
| `qwen3.8-max`, `qwen3.8-flash` | `40% Off Nights` | Без ночного бейджа |
| `qwen4-max` | Без ночного бейджа | Без ночного бейджа |
| `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017` | 50% ночью | 50% ночью |

В китайском ответе Individual для `auto`, `qwen3.8-max` и `qwen3.8-flash` указано `4 折`,
то есть расход может снижаться до 40% обычного. Английский ответ тех же строк говорит о
скидке 40%. [Документация Individual](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview)
указывает скидку 60% для двух моделей Qwen 3.8. Для `auto` документация размер скидки
не называет. Фактическое списание на аккаунте не проверялось.

[Правила расхода](https://docs.qwencloud.com/token-plan/token-plan-usage-quota#night-discount)
подтверждают окно 22:00–08:00 UTC+8. Описания бейджей подтверждают ежедневное применение.
В Новосибирске окно соответствует 21:00–07:00. С 07:00 до 21:00 действует обычная ставка
соответствующей модели. В документации нет отдельного повышающего коэффициента за этот период.

## Привязка к GrigDesk

Настройка `qwencloud-token` использует один inference endpoint для Individual и Team.
Вид подписки из этого выбора установить нельзя. Для точного бейджа применимы выбранный
вид подписки и ID модели, доступной в каталоге данного подключения. Другие сервисы Qwen
используют свои условия. Сведения о персональном остатке и сбросе описаны в
[исследовании квот](qwen-token-plan-usage.md).
