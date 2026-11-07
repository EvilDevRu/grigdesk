"""Точный opt-in контракт сдачи; legacy не получает новых полей."""

ACTIONS = {
    "commit": ["commit"],
    "merge": ["commit", "merge"],
    "pull-request": ["commit", "push", "pull-request"],
}


def validate(strategy, actions):
    """Проверяет точный набор разрешений, включая отсутствие дубликатов.

    Новая стратегия не может незаметно получить внешние действия legacy.
    """
    if strategy not in ACTIONS or sorted(actions) != sorted(ACTIONS[strategy]):
        raise ValueError("неверная стратегия сдачи или набор действий")


if __name__ == "__main__":
    import sys

    try:
        strategy = sys.argv[1]
        if len(sys.argv) > 2:
            with open(sys.argv[2], encoding="utf-8") as source:
                rows = [line.rstrip("\n").split("\t") for line in source]
            if any(len(row) != 2 or row[0] not in {"action", "strategy", "target"} for row in rows):
                raise ValueError("неверный pin сдачи")
            if [row[1] for row in rows if row[0] == "strategy"] != [strategy]:
                raise ValueError("стратегия pin не совпадает")
            validate(strategy, [row[1] for row in rows if row[0] == "action"])
        else:
            print("\n".join(ACTIONS[strategy]))
    except (KeyError, ValueError, OSError, IndexError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(78)
