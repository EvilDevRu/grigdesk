# Память проекта

## Кокпит

- [Перезапись кэша выше 250k](cockpit/chat-context-cache-rewrite.md) — процесс на сообщение + большой контекст = каждый ход пишет кэш заново, 94% расхода записи

## Движок

- [Мотивация route v2](engine/route-v2-motivation.md) — readonly-нарушения (trace-verify) и несостыковки схем; агент = шаблон, маршрут = immutable бандл
- [Никакого хардкода проекта в движке](engine/no-project-hardcode-in-engine.md) — arsenkin-хардкод в factory-v2 отмечен пользователем как недопустимый, план выноса согласован
- [Замер в песочнице недостоверен](engine/sandbox-measurement-noise.md) — соседние стенды дают разброс до 76%, данных в 46 раз меньше боевых: мерить счётчики, не время
- [Ложное срабатывание сторожа](engine/guard-false-positive-fix-source.md) — наблюдать только то, что переживает снос песочницы; volatile-список — шрамы, а не свойства проекта
- [Маркер трассировки в логе приложения](engine/trace-marker-in-app-log.md) — FACTORY-TRACE в storage/logs/laravel.log валит cleanup транзакции навсегда (код 75)
- [Снимок env песочницы](engine/sandbox-env-snapshot.md) — .env.testing трекается и правится up.sh: VERIFY сверяет с t&lt;task&gt;.sandbox-env.sha256, иначе валит каждый прогон
- [Typed failure routing по маршрутам](engine/debug-route-no-typed-failure-routing.md) — без onFailure отказ «нужно решение человека» инертен; в debug добавлено, в hunt/perf/trivial/consilium-debug нет

## Поведение

- [Можно ждать человека](behavior/wait-for-human-password.md) — упёрся в пароль/ручной шаг: спроси через панель действий и жди, а не выдумывай обход
