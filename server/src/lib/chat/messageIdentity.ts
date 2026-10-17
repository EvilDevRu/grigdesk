// Общая идентичность сообщений нужна серверу и окну.
// Фасад сохраняет прежние пути импортов потребителей сервера.
export { stableMessageKey, legacyMessageKey, messageKey }
  from "../../../../shared/chat/chatMessageIdentity.ts";
