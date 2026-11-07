# Preflight живого допуска GLM

`deepseek/scripts/admissionPreflight.mts --mode api|coding-plan` проверяет входы рабочего
дерева до сборки, без модели и изменения списка допуска. Флаги `--compatibility <файл>`
и `--host-contract <файл>` позволяют явно выбрать список и ревизии host-контракта.
Команда `npm --prefix deepseek run --silent admission:preflight -- --mode api` вызывает
тот же скрипт.

Одна строка JSON содержит `consumerMode`, `missing` (режимы без совпавшей записи) и
`pluginMissing`. Отсутствующий llm-pi-ai закрывает оба режима. Ошибка чтения или расчёта
даёт ненулевой код; CLI возвращается к прежнему вопросу с пропуском по умолчанию.

`glmRuntimeIdentity` в `buildRuntime.mts` — общий источник vendor commit, composition,
dependency lock и identity плагина для preflight и metadata сборки. Правка входов,
включая код самого билдера, требует нового живого допуска с `--admit`. Preflight
управляет только вопросом; окончательные ворота остаются у `admission:check` кандидата,
установщика и runtime.

В терминале покрытый допуск режима потребителя убирает вопрос. При отсутствии допуска
Enter выбирает smoke указанного режима, а «Оба режима» и отложенная установка доступны
явно. При отложенной установке shell отправляет `hint deepseek-deferred <mode>`, и итог
CLI показывает предупреждение с подсказкой вместо сообщения об установленном ELF.
Код выхода остаётся 0. Неинтерактивный поток и значения `GRIGDESK_DEEPSEEK_SMOKE`
`none|consumer|both` сохраняют прежнюю семантику.
