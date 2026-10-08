# Claude: ultracode — скрытое значение `--effort`

Проверено 2026-10-08 по бинарю установленного Claude Code 2.1.293.

- `claude --help` перечисляет у `--effort` только `low`, `medium`, `high`, `xhigh`, `max`.
- Парсер флага принимает и скрытый псевдоним `ultracode`: в бинаре он отображается в
  `xhigh` и одновременно включает ultracode сессии. `claude --effort ultracode --version`
  проходит без предупреждения, а неизвестное значение даёт
  «Unknown --effort value … ignoring it». Проверка бесплатна: запроса к модели нет.
- Ultracode — постоянная оркестрация динамических workflow (субагентов) на любом уровне
  усилия. Через `--effort ultracode` глубина рассуждения равна `xhigh`, не `max`.
  Отдельно его можно включить булевым полем `ultracode` через `--settings` или control
  request `apply_flag_settings`; интерактивный переключатель его не сохраняет. В TUI он
  включается клавишей Tab в слайдере усилия, а `/effort` принимает `ultracode [on|off]`.
- Доступность: включённые workflow и модель с поддержкой `xhigh`. Иначе
  `apply_flag_settings` отвечает «ultracode is not available for this session».
- Ключевое слово `ultracode` в тексте запроса включает workflow только на этот ход.

Кокпит это значение пока не предлагает: слайдер Claude строится из списка `--effort`
в `claude --help`, а `ultracode` в справке скрыт.

Источники:

- `claude --help`: строка `--effort <level>`.
- Встроенный код бинаря: карта псевдонимов усилия и описание поля настроек `ultracode`.
- `server/src/lib/executors/claude.ts`: `parseClaudeEfforts`.
