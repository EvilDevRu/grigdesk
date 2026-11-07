# Замена DeepSeek сохраняет работу event loop

Установка нового ELF не останавливает уже запущенный web-процесс A. Метаданные и файловая
проверка серверного descriptor асинхронны; полный integrity payload принадлежит launcher.
Установщик выполняет probes в отдельном процессе и публикует проверенный ELF через rename.
Legacy публикация generation, activation и fork из production удалены.

WebSocket-клиент должен успевать отвечать на Ping. Длительный синхронный обход generation
в серверном event loop мог закрыть рабочее соединение, даже когда модель продолжала ответ.
Сроки SDK и heartbeat ради упаковки не изменены. Подготовка тестовых вариантов также
использует асинхронную проверку, чтобы fixture не блокировала собственный WebSocket.

`tests/server/deepseek-runtime-rollback.test.js` проверяет активный A при подготовке B,
A→B→A в одном home с resume и отказ/ротацию будущего номера журнала. Независимая установка
на одном работающем Fastify проверяется `deepseek-binary-independent-update.test.js`.
Намеренное удержание первого HTTP ограничено по
[правилу жизни фикстуры](../testing/fixture-held-turn-deadline.md).
