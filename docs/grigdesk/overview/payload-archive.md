# Общий codec payload ZIP

`shared/node/payloadArchive.ts` содержит индекс, link resolver и потоковый reader.
Factory получает ошибку consumer и ZIP port; сторонние пакеты shared не импортирует.
Пакетные adapters сервера и DeepSeek импортируют fflate и сохраняют собственные коды
server_payload_invalid и deepseek_payload_invalid. Входы сборки DeepSeek включают codec.

До файловых эффектов проверяются канонические относительные пути, родители, дубли,
типы, modes, sizes и SHA. Link chains не выходят за корень; запись через link запрещена.
Reader принимает ровно файлы индекса, проверяет полные SHA/size архива и каждого файла.
Лишние, повторные, повреждённые и оборванные записи приводят к отказу и abort активных sinks.
