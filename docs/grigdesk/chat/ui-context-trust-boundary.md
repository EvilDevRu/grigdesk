# UI-context — данные, а не полномочия; identity companion-чата принадлежит серверу

Контекст страницы легко случайно превратить во второй роутер полномочий. Это запрещено для
любого хода чата: в запрос модели уходит только bounded `promptContext` (`page`, canonical
`path`, positive-schema `details`), и сервер повторно нормализует его как недоверенные данные.
Ни `details.taskId`, ни `details.scope`, ни path вроде `/routes` не выбирают cwd, worktree,
режим или разрешения; маршрут хода задаёт только сам endpoint (`/api/chat` или
`/api/tasks/<id>/chat`). DOM, скриншот, PTY output и введённые команды в контекст вообще не
читаются. Trusted `routingScope` из `capture(route)` живёт только на клиенте, в HTTP не
сериализуется и после сноса компактного компаньона (2026-09-10) потребителя не имеет.

Logical identity companion-чата принадлежит серверу. `POST /api/chat/store/ensure` под
logical-key lock создаёт ровно один `purpose: "companion"` разговор для global/exact-task;
обычный PUT не вправе назначить или перепривязать `logicalIdentity`, найденные дубли дают
явный `409 companion_chat_conflict`, а ход по такому чату обязан идти маршрутом своей
identity (`409 companion_scope_mismatch`). Иначе два окна (или пульт и окно) тихо
разошлись бы на две истории, а устаревший полный snapshot стёр бы живой разговор.
Одного числового `taskId` недостаточно: ensure подтверждает его factory registry или live B24
(`taskExists` в `app.ts`). Принятый или ожидающий ход блокирует DELETE истории
(`409 chat_busy`), даже пока executor ещё не появился в `activeRuns`.

Чего больше НЕТ и что не надо возвращать по старым записям: маркера `companionTurn` с
plan-only gate и проверками exact worktree, серверного вердикта `speechSafe` для озвучки,
browser `speechSynthesis` с device-local consent, адресации Stop через exact chat пузыря.
Всё это жило ради компактного компаньона и снято вместе с ним.
