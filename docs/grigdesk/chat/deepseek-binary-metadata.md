# Metadata автономной поставки DeepSeek

Чистая схема `shared/chat/deepSeekBinary.ts` проверяет описание поставки format 1:
версии поставки и upstream, packageId и buildId, hostContract, платформу, worker Node,
capabilities и входы GLM с записями допуска. Дополнительные поля совместимого format
допускаются. Неизвестные format и hostContract отвергаются. Декодер не ограничивает
upstream текущей закреплённой версией и не сравнивает ABI worker с ABI сервера.

`journal: { write, read }` обязателен: номера codec неотрицательные, `read` содержит `write`.
Ноль — настоящий исторический codec upstream (`session.jsonl`), а не wildcard совместимости.
Версия поставки и совместимость журнала являются разными свойствами.

`deepseek/src/runtime/metadata.ts` вычисляет packageId как SHA256 канонического manifest
без самого поля packageId. В отпечаток входят binaryVersion и дополнительные поля
manifest. Ключи объектов сортируются рекурсивно, порядок массивов сохраняется. Общая
канонизация в `shared/lib/canonicalJson.ts` также сохраняет прежнюю формулу допуска GLM.

`server/deepseek-host-contract.json` содержит требования установленного GrigDesk к
format, hostContract, capabilities и ревизиям профиля/политики GLM. Проверка сопоставляет
поставку с этим отдельным документом. Чтение metadata не доказывает целостность payload
и само по себе не предоставляет модельный допуск.

Парсер `deepseek/src/launcher/args.ts` читает флаги launcher до первого аргумента
Harness. Остаток argv передаётся целиком, включая неизвестные и совпадающие с
launcher флаги. Metadata-режимы несовместимы с аргументами Harness; `runtime-info`
и `verify` требуют `--json`. `--cache-dir` принимает только абсолютный путь,
парсер его не открывает и не вычисляет путь из HOME.

Формирование ошибки сохраняет stdout пустым: ошибки аргументов дают код 2,
прочие — код 1. В metadata-режимах stderr содержит JSON с безопасными `code`
и `message`; сырые ошибки не печатаются.
