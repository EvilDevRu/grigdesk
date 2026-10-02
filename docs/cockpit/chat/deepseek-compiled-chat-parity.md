# Проверки чата на собранном DeepSeek

`tests/server/deepseek-vendored-chat.test.js` запускает настоящий web runtime с production
overlay и файловой песочницей. Только API endpoint заменён на локальный HTTP/SSE fixture.
Первый и следующий ход сохраняют session memory; модель, effort, инструкции и общие
настройки проверяются по фактическим запросам. Busy ход сохраняет принятый snapshot,
следующий получает новое значение, unset возвращает base.

Проверены поток reasoning/text, stop, вопрос и ответ, steer, approval allow/reject,
одновременные отдельные homes, project/host MCP, SSH и DB hooks. Одно text message даёт
один сохраняемый шаг: его текст обновляется при новых chunks, а live события продолжаются.
Usage и billing не заменяются вымышленными значениями.

Файловые проверки подтверждают запись внутри cwd, read-only, отказ записи в родительский
каталог и symlink escape. Штатные временные writable roots Harness, включая `/tmp`,
сохраняются; fixture проверки границы располагается вне временного каталога.
Тесты не обращаются к внешней модели, не читают пользовательские homes и не перезапускают сервер.
