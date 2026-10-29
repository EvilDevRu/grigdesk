# Окружение запуска и источники лимитов исполнителей

Проверка проблемы PATH у Kimi охватывает все шесть встроенных адаптеров.
Наличие CLI и чтение статистики — разные проверки: исправный ответ баланса не доказывает
готовность модельного хода, а отсутствие программы не означает исчерпание квоты.

| Исполнитель | Запуск и окружение | Получение статистики |
| --- | --- | --- |
| Claude | Внешний CLI; общий подготовленный shell-снимок и reader lease, адресные overrides хода | HTTPS-чтение OAuth usage; отдельный CLI-сервер для этого не запускается |
| Codex | Внешний CLI; общий подготовленный shell-снимок и reader lease | Короткий `app-server` с методом `account/rateLimits/read`, без thread/turn и без собственного урезанного PATH |
| Kimi host | Внешний CLI; host launch сохраняет caller-env, web runtime добавляет каталог Kimi | Короткий `kimi web`; PATH сохраняет общий подготовленный shell-снимок или родительское окружение |
| DeepSeek | Выбранный автономный ELF по абсолютному пути; общий allowlist Harness пропускает PATH | HTTPS-чтение баланса по отдельному ключу DeepSeek |
| GLM | Автономный Harness по абсолютному пути; тот же allowlist с отдельным ключом выбранного режима | HTTPS-чтение баланса API или квот Coding Plan |
| Tripo | API-адаптер, исполняемый CLI не требуется | HTTPS-чтение credits выбранного региона |

Фиксированный PATH contained-профиля Kimi относится к смонтированной песочнице и не
подменяет host-окружение. Managed DeepSeek/GLM и Tripo не получают capability `externalCli`.
Подробности общего выбора программы и leases — [lifecycle внешних CLI](external-cli-lifecycle.md).
Причина и исправление отдельного брокера Kimi — [путь к Node.js](kimi-usage-node-path.md).

Проверки: `external-cli-process`, `external-cli-adapter`, `provider-usage`,
`providers-usage-tick`, `kimi-usage-startup`, `kimi-host-launch`, `kimi-server-runtime`,
`deepseek-provider`, `deepseek-usage`, `glm-provider`, `glm-env`, `glm-usage`,
`glm-startup`, `tripo-provider`, `tripo-client` в `tests/server/`.
