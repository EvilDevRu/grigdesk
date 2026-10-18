# Telegram-пульт

Пульт GrigDesk в Telegram: владелец, вотчер прогонов, действия и ассистент.

Читай перед правкой: `server/src/lib/telegram`, `server/src/modules/telegram`.

## Устройство

- [Владелец (безопасность)](owner-security.md)
- [Вотчер (lib/telegram/pult/watch.ts)](watcher.md)
- [Гигиена текста](text-sanitization.md)
- [Грабли, ради которых тут всё так](operational-pitfalls.md)
- [Действия (lib/telegram/pult/actions.ts)](actions.md)
- [Клавиатура и меню команд](keyboard-and-commands.md)
- [Классификация входящего текста](message-classification.md)
- [Ключевой принцип: пульт — ещё одно «окно» GrigDesk](control-panel-principle.md)
- [Разговор с ассистентом (lib/telegram/pult/assistant.ts)](assistant-conversation.md)
- [HTTP и хранение](http-and-storage.md)
