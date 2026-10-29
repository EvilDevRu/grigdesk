# Единые подписи окон лимитов

Известные окна Codex, Claude, Kimi и GLM показываются одинаково во всех местах интерфейса:

| Окно | Русский | Английский |
|---|---|---|
| 300 минут | 5 часов | 5 hours |
| 10 080 минут | Неделя | Week |
| Календарный месяц Kimi | Месяц | Month |
| Месячная квота MCP у GLM | MCP за месяц | Monthly MCP |

Владельцем видимой подписи служит `localizeUsageBar` в
`web/src/features/providers/providerUsage.ts` и общий каталог `core.json` для RU/EN.
Проекция используется полосами поповера, компонентом `ProviderUsageForecast` и
`providerUsageSummary` для строки состояния чата. Русский язык проходит ту же обработку,
поэтому исходные «Сессия (5ч)» и «Неделя (7д)» больше не создают отдельный формат.

Источники полос остаются в адаптерах: `parseCodexRateLimits` в `executors/codex.ts`,
`parseClaudeUsagePayload` в `executors/claude.ts`, события Claude в `_claudeStream.ts`,
`parseKimiUsageBars` в `kimi/usage.ts` и окна Coding Plan в `glm/usage.ts`.
Их исходные подписи и сохранённые снимки не требуют миграции.

Длительность берётся из `windowMinutes`. Если её нет в прежнем формате, известные ключи
Claude и Kimi определяют пятичасовое или недельное окно; индекс строки Kimi значения
не имеет. Суффикс после « · » сохраняет имя модели или квоты. Неизвестные окна и внешние
исполнители сохраняют прежний контракт, а месячная квота не получает выдуманную длительность.
Проекция не меняет ключи, группы, проценты, даты сброса и исходный объект.

Проверки: `tests/web/provider-usage.test.js`,
`tests/web/provider-usage-forecast.component.test.js`, `tests/web/provider-usage-summary.test.js`.
