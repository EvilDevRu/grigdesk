# Source-фикстуры рядом с установленным ELF

Наличие `bin/grigdesk-server` в checkout включает packaged-ветку runtime-env по умолчанию.
Source-проверки Node, портов, dotenv и переноса данных явно передают существующий аргумент
`source` в `grigdesk_require_node`, `grigdesk_load_runtime_env`, `grigdesk_require_migrated`.
Это сохраняет продуктовый маршрут разработчика и исключает зависимость от локального ELF.
Packaged-проверки используют собственную копию установки.

Фикстура route-v2 для HTTP `/gate` задаёт физические `rootDir`, `factoryHome`, `factoryBin`
и собственную `dataHome`. Общий dataHome оставляет registry со ссылками на уже удалённые
временные roots и приводит к `factory_runtime_registry_invalid`. Control создаётся с 0700,
как в `engine/lib/attempt-state.sh`; state и profiles существуют отдельно от control.

Legacy-попытка без серверного runtime pin остаётся управляемой. Её trusted файлы:
`protocol-v2/tasks/t<N>/protocol.json` со schema 1 / protocolVersion 2, `attempts/<a>/attempt.json`
и `attempt.sha256` принадлежат текущему uid, имеют 0400 и корректную контрольную сумму.
Первый `/gate` в source-режиме возвращает 200 и публикует authority и индекс pin с
`packageId: null`, без reservation. Проверка в `factory-gate-cursor.test.js` начинает
именно с отсутствующего pin и проверяет его после HTTP-вызова; ошибки trusted файлов
или исчезнувшего закреплённого runtime по-прежнему запрещают мутацию.
