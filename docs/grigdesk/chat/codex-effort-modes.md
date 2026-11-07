# Codex: xhigh, max и ultra

Проверено 2026-10-08 по встроенному каталогу установленного Codex и официальной
документации OpenAI.

- `xhigh`: очень глубокое рассуждение для сложных задач.
- `max`: максимальная глубина рассуждения для самых трудных задач.
- `ultra`: максимальное рассуждение с автоматическим делегированием задач.
  Встроенный каталог описывает его как «Maximum reasoning with automatic task delegation».
  Отличие от `max` включает организацию работы субагентов; это не просто следующая
  ступень глубины рассуждения.

Официальный API guide перечисляет `xhigh` и `max` как уровни `reasoning.effort`,
а ultra mode в Codex упоминает при сравнении с параллельной работой нескольких агентов.
Поддержка уровней зависит от модели. Более высокий effort может увеличить время и
расход токенов; гарантированного выигрыша качества или фиксированного множителя нет.
GrigDesk получает имена доступных уровней из `model/list`, без собственной таблицы уровней.

Источники:

- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Using GPT-6, раздел Using GPT-5.6 / What's new](https://developers.openai.com/api/docs/guides/latest-model)
- Встроенный каталог бинаря Codex: описания `supported_reasoning_levels`.
- `server/src/lib/executors/codex.ts`: `parseCodexModelList`.
