# Остановка worker автономного DeepSeek

SEA запускает обычный упакованный Node через IPC bootstrap. Stdin/stdout/stderr
передаются отдельными inherited streams без перепаковки ACP frames. Bootstrap ставит
обработчик disconnect до импорта Harness: смерть launcher начинает штатный disposal
worker. Launcher ждёт закрытия worker и сохраняет его exit code.

Host entry сначала освобождает context. Штатный TERM/EOF возвращает 0, INT — 130.
Истечение трёх секунд disposal возвращает 75. Этот исход означает отказ cleanup;
он не выдаётся за успешную остановку. Launcher пересылает TERM/INT и ограничивает
ожидание worker четырьмя секундами, после чего эскалация также возвращает 75.
Таймер disposal удерживает event loop: один pending Promise после закрытия web sockets
не удерживает Node и без этого позволил бы ему естественно выйти с кодом 0.

Проверка на настоящем production ELF включает managed shell upstream subprocess
service и изменяющийся marker: stop, EOF, TERM/INT, внешний SIGKILL, зависший disposal,
эскалацию группы, смерть во время boot и повторный запуск. Штатный возврат подтверждает
отсутствие worker и команды; marker больше не меняется. Режим containment записывается
по фактическому выбору upstream: scope либо fallback group.

Отдельные проверки сохраняют cwd/env и patch с пробелами, чистоту ACP stdout,
отдельный stderr, exit code worker и отказ по чужому packageId до его запуска.

Серверный `binaryProcess.ts` создаёт собственную detached process group без unref.
PGID захватывается при spawn; callers не передают произвольную группу для остановки.
Stop отправляет TERM launcher, ждёт до шести секунд закрытия stdio и исчезновения
группы. Затем KILL только своей группе, до двух секунд ожидания и ошибка cleanup.
Код 75 также даёт отказ. Повторный stop возвращает тот же promise и не сдвигает deadline.
Неожиданный exit launcher запускает тот же cleanup автоматически, оставляя worker
время на IPC disconnect; ненаблюдаемый отказ не теряется и возвращается последующим stop.

Binary web, ACP turn, ACP settings и catalog используют этот owner. Клиентский EOF
закрывается после owner stop, чтобы не отправить второй TERM во время disposal.
Startup abort также дожидается cleanup. При cleanup отказе launchDir сохраняется;
верхние finally DeepSeek и GLM не удаляют его как после успеха.

Отказ cleanup после отправленного prompt сохраняет `retryState: post_prompt`, sessionId
и принятые шаги. Вызывающий не должен воспринимать его как безопасный отказ до prompt.
Это проверяется настоящим ELF и одним запросом к loopback model API.
