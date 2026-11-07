# HTTP и хранение

- `POST /api/telegram/pult` `{botId, chatId}` — проверка «бот слышал эту личку» +
  отправка кода (pending появляется только ПОСЛЕ успешной отправки);
- `POST /api/telegram/pult/confirm` `{botId, code}` — включение: ставит постоянную
  клавиатуру в личку и `setMyCommands` со scope `BotCommandScopeChat` владельца;
- `POST /api/telegram/pult/disable` `{botId}` — выключение (выбор чата сохраняется):
  `deleteMyCommands` того же scope + `ReplyKeyboardRemove` владельцу;
- блок `pult` в `GET /api/telegram/status`: `{configured, confirmed, pending, chatTitle,
  chatHint}` — сырой chat id наружу не уходит (маска `…last4`).
- Отказы именованные: `pult_chat_unknown`, `pult_not_private`, `pult_code_mismatch`,
  `pult_code_expired`, плюс общие `telegram_*`. Выключенный плагин — 404
  `plugin_disabled` (живой гейт), он же глушит и вотчер, и обработку входящих.

Файлы: `lib/telegram/pult/{watch,actions,assistant,voice,format,state-store,send-queue}.js`; сборка —
в `app.js` (после регистрации модулей: пульту нужен inject по готовым ручкам; поллер
получает late-bound хуки `onMessage`/`onCallback`). Вотчер стартует безусловно и сам
гейтится живьём — включение пульта не требует рестарта. Серверные правки пульта
вступают в силу только после ручного перезапуска сервера человеком — сам пульт и
ассистент сервер не перезапускают (ассистент — дочерний процесс этого сервера, и
перезапуск убьёт ход, который его ждёт).
