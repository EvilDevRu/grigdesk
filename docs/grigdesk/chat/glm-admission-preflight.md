# Preflight живого допуска GLM

`deepseek/scripts/admissionPreflight.mts --mode api|coding-plan` проверяет входы рабочего
дерева до сборки, без модели и изменения списка допуска. Флаги `--compatibility <файл>`
и `--host-contract <файл>` позволяют явно выбрать список и ревизии host-контракта.
Команда `npm --prefix deepseek run --silent admission:preflight -- --mode api` вызывает
тот же скрипт.

Одна строка JSON содержит `consumerMode`, `missing` (режимы без совпавшей записи) и
`pluginMissing`. Отсутствующий llm-pi-ai закрывает оба режима. Ошибка чтения или расчёта
даёт ненулевой код.

`glmRuntimeIdentity` в `buildRuntime.mts` — общий источник vendor commit, composition,
dependency lock и identity плагина для preflight и metadata сборки. Правка входов,
включая код самого билдера, требует нового живого допуска с `--admit`. Окончательные
ворота остаются у `admission:check` кандидата, установщика и runtime.

Go CLI задаёт вопрос по результату `admission:check` уже собранного ELF.
Preflight можно запускать отдельно для диагностики входов рабочего дерева.
[Действия меню, режимы и результат отложенной установки](../server/ctl-build.md).
