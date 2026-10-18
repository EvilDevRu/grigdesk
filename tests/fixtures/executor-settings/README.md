# Фикстуры нативных настроек

`synthetic-catalog.json` — обезличенный wire-каталог протокола GrigDesk 1.
Исполнитель `future-provider` существует только в тестах. Значения синтетические;
аккаунты, пользовательские конфиги и реальные пути здесь не используются.

| Файл/источник | Версия и формат | Происхождение и сценарий |
| --- | --- | --- |
| `synthetic-v1.json` | JSON Schema 2020-12 | Вручную созданная boolean-схема пятого исполнителя |
| `synthetic-v2.json` | Тот же dialect | Добавлен незнакомый typed leaf в прежний channel |
| `synthetic-v3.json` | Тот же dialect | Исходное поле удалено из complete-области |
| `synthetic-v4.json` | Тот же dialect | Enum нового поля больше не допускает прежний override |
| `types.json` | JSON Schema | Синтетические refs, typed enum, nullable, группы и массивы |
| `schemastery.json` | Schemastery uid/refs | Синтетический граф с min/step и union констант |
| `deepseek.json` | DSH 0.1.5-rc.2, settings/describe + Schemastery | Сокращённая синтетическая wire-форма изученного протокола; future namespace и redacted sentinel |
| Inline в `provider-settings-claude.test.js` | Claude 2.1.285, get_settings + JSON Schema | Синтетические effective/sources/applied, типовые конфликты и ownership |
| Inline в `provider-settings-codex.test.js` | Codex 0.159.2, сгенерированная Config schema + RPC | Две синтетические страницы features, managed/removed/unknown stage |
| Inline в `provider-settings-kimi.test.js` | Kimi 0.33.0, OpenAPI 3.0/3.1 | Синтетические POST/GET schemas с нетипизированными и приватными ветками |

Это protocol-shaped fixtures, а не копии пользовательских данных или полный schema
dump CLI. Реальные изолированные пробы хранятся только в `.state/artifacts/` и не
являются зависимостями тестов. Fake CLI фиксируют фактические argv/RPC/POST до prompt;
тесты не подключаются к аккаунтам и не вызывают модели.
