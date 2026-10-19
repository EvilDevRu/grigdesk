# GLM parity на автономном ELF

`tests/server/glm-binary-parity.test.js` выбирает бинарную fixture и регистрирует те же
сценарии из семи файлов `glm-vendored-{profile,turn,policy,mcp,catalog,session,stop}`.
Их отдельные запуски сохраняют legacy fixture. Меняется подготовка runtime; существующие
assert-проверки одинаковы для обоих способов доставки.

`ensureGlmTestRuntime` проверяет настоящий candidate один раз на процесс. Binary-ветка
задаёт ELF и cache-dir явно и оставляет legacy artifact недоступным. Production adapter,
overlay, hooks, native subprocess и журнал сохраняются; подменены адрес модели на
loopback и fetch guard. Тестовый допуск вычисляется по metadata, admission выпуска не меняется.

Набор проверяет ответ/reasoning, реальные инструменты, файловые и командные запреты,
MCP readiness/loss/current tools, каталог без prompt, resume, остановку и обрыв после
эффекта. Запреты проверяются отсутствием sentinel и счётчиками вызовов. После crash
предыдущий эффект не повторяется автоматически; новый вызов модели проходит hook заново.

Таблица `web и GLM на настоящем ELF проходят полную таблицу исходов остановки` в
`tests/server/deepseek-binary-stop.test.js` проверяет по девять исходов для каждого caller:
stop/TERM/INT/KILL, зависший disposal, эскалацию, IPC EOF, незавершённый boot с повторным
запуском и abort во время старта. Проверяются принадлежащие fixture PID и стабильность marker.

На том же ELF отдельный настоящий DeepSeek turn подтверждает свой provider через
`settings/describe` и отсутствие смонтированного `llm-pi-ai`. Ключи и homes двух
исполнителей разделены. Полный цикл A→B→A и v99 — в
[проверках памяти GLM](glm-binary-memory.md).

Offline parity не выдаёт живой допуск GLM: production по-прежнему требует точную запись
compatibility из metadata выбранного выпуска.
