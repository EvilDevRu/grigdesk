#!/usr/bin/env bash
# PreToolUse-хук проверяющего узла: запрет записи через перенаправление.
#
# Зачем он есть. Права CLI — префиксные: правило сверяет НАЧАЛО команды и середину не
# читает. Поэтому `echo` проверяющему узлу не выдавался вовсе: `echo x > file` правилом не
# выражается, и разрешить `echo` значило бы разменять предупредительный рубеж на посмертного
# сторожа, который валит узел уже после всей его работы.
#
# Цена запрета оказалась крупнее, чем ожидалось. Замер по журналам всех прогонов: из 1302
# отказов прав `echo`/`printf` участвует примерно в 610, и ПЕРЕНАПРАВЛЕНИЕ содержат лишь
# 12% из них. Остальное — метки-разделители (`git status && echo "--- FE ---" && …`) и
# хвост `; echo "exit=$?"`, то есть команды, которые записать не могут ничего. Они отказаны
# целиком, потому что CLI разбирает составную команду по частям и решает самая слабая.
#
# Хук закрывает ровно эту дыру: он видит команду ЦЕЛИКОМ, до исполнения. Замер на живом
# `claude -p` (haiku, 26.08.2026): `echo probe > /tmp/out` отклонён хуком, файл не создан;
# `rm -f …` при молчащем хуке отклонён обычным deny-списком; `echo hello` выполнен. То есть
# хук не подменяет права, а дополняет их там, где префикс слеп.
#
# Контракт хука (Claude Code): на stdin — JSON события, на stdout — либо ничего (решает
# обычный список прав), либо решение. Отказ попадает в `permission_denials` результата, то
# есть продолжает считаться счётчиком `DENIALS_<STAGE>` и остаётся виден человеку.
#
# Граница названа честно: хук ловит перенаправление оболочки, а не запись вообще.
# `awk '{print > "f"}'` записывает файл изнутри кавычек, и ни это правило, ни префиксное
# его не видят — такую запись по-прежнему ловит только посмертный сторож узла. Хук не
# делает эту дыру шире: он лишь возвращает узлу команды, которые и так ничего не пишут.
set -uo pipefail

# Каталог состояния приезжает аргументом, а не переменной окружения: settings.json пишет
# движок, и адрес там уже известен. Окружение до хука доходит через CLI, то есть через
# чужой процесс, и молчаливая потеря переменной превратила бы рубеж в запрет всякой записи.
state_dir=${1:-}

payload=$(cat) || exit 0

# Сторож, который сломался, обязан быть ГРОМКИМ. Молчание хука означает «решает обычный
# список прав», то есть сломанный сторож молча вернул бы дыру, ради которой он написан, —
# и заметить это было бы нечем. Поэтому любой ненулевой код питона превращается в отказ:
# узел встанет сразу и с названной причиной, а не отработает сорок минут без рубежа.
decision=$(printf '%s' "$payload" | STATE_DIR_ARG="$state_dir" python3 -c '
import json
import os
import re
import shlex
import sys

# Разрешённые формы перенаправления. Всё остальное с `>` — отказ.
#   - дублирование дескриптора: 2>&1, 1>&2, >&2, 2>&-
#   - вывод в /dev/null
#   - запись в КАТАЛОГ СОСТОЯНИЯ: `state-only` значит «дерево проекта только читаем»,
#     а не «не пишем вовсе». Проверяющий узел кладёт туда свой отчёт и черновик хода —
#     замер по журналам: из 342 команд, которые первая редакция правила отклоняла зря,
#     подавляющее большинство это `cat >> <state>/t<id>.review.checkpoint.md <<EOF`.
#   - запись во временный каталог: она дереву не вредит и является ШТАТНЫМ способом
#     сравнить файл с его версией из HEAD, не пачкая worktree (оплаченный инцидент
#     `docs/grigdesk/gotchas.md`: запись такой копии В worktree роняет узел fail-closed).
# Токенизатор с `punctuation_chars` сам отделяет операторы от слов, поэтому `2>/dev/null;`
# разбирается как `2`, `>`, `/dev/null`, `;`, а `>` внутри кавычек остаётся частью слова и
# оператором не считается. Ручной разбор этого не умел: точка с запятой прилипала к пути,
# и 124 команды из 3265 в замере по живым журналам отклонялись зря.
WRITE_OPS = {">", ">>", "&>", "&>>"}
DUP_OPS = {">&", "&>&"}
FD_TARGET = re.compile(r"^(?:[0-9]+|-)$")
# Кавычки в классе заданы кодами: сам питон приезжает в bash одинарными кавычками
# (`python3 -c ...`), и литеральный апостроф закрыл бы строку посреди регулярки.
HEREDOC = re.compile(r"<<-?\s*([\x22\x27]?)([A-Za-z_][A-Za-z0-9_]*)\1")

STATE_DIR = os.environ.get("STATE_DIR_ARG") or ""
TEMP_DIRS = ("/tmp/", "/var/tmp/")


def writable_target(target):
    if not target:
        return False
    if target == "/dev/null":
        return True
    if target.startswith(TEMP_DIRS):
        return True
    if STATE_DIR and (target == STATE_DIR or target.startswith(STATE_DIR + "/")):
        return True
    return False


def strip_heredocs(command):
    """Тело heredoc — данные, а не команда.

    Без этого `stage-probe.sh --lang python <<PY` с обычным питоном внутри отказывался
    бы сам себе: сравнение `if a > b:` в теле выглядит для токенизатора голым оператором
    перенаправления. Вырезаем от строки с открывающим `<<` до строки-ограничителя.
    """
    lines = command.split("\n")
    out = []
    index = 0
    while index < len(lines):
        line = lines[index]
        out.append(line)
        match = HEREDOC.search(line)
        index += 1
        if not match:
            continue
        delimiter = match.group(2)
        while index < len(lines) and lines[index].strip() != delimiter:
            index += 1
        if index < len(lines):
            index += 1
    return "\n".join(out)


def refusal(target):
    """Отказ называет законный адрес записи, а не только запрет.

    Голое «запрещено» агент читает как запрет записи вообще и уходит в запрещённые формы
    той же записи: живой узел после такого отказа перебрал cp и tee, получил ещё четыре
    отказа и закрыл этап failed, хотя cat в абсолютный путь был разрешён. Поэтому каталог
    состояния назван буквально, а неабсолютный путь объяснён отдельно: оболочка учтёт cd,
    тильду и переменные, а сторож видит только сырую строку команды.
    """
    state = STATE_DIR or "каталог состояния"
    if target.startswith("/"):
        return (
            "проверяющий узел не пишет в дерево проекта: перенаправление в "
            f"{target} запрещено. Писать можно только по абсолютному пути внутри "
            f"{state} или /tmp, читать — где угодно"
        )
    return (
        f"перенаправление в {target} запрещено: путь не абсолютный. Сторож не раскрывает "
        "тильду и переменные и не учитывает cd, поэтому считает такой путь записью в "
        f"дерево проекта. Укажи буквальный абсолютный путь внутри {state} или /tmp; "
        f"копия файла — cat <откуда> > {state}/<куда>"
    )


def verdict(command):
    if not command:
        return None
    lexer = shlex.shlex(strip_heredocs(command), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        # Незакрытая кавычка: разобрать команду нечем, а пропустить неразобранное
        # означает отдать рубеж целиком. Оболочка такую команду тоже не выполнит.
        return "не удалось разобрать команду; перепиши её проще"
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if token not in WRITE_OPS and token not in DUP_OPS:
            continue
        target = tokens[index] if index < len(tokens) else ""
        index += 1
        # `2>&1` — дублирование дескриптора, а не запись: цель у него число или `-`.
        if token in DUP_OPS and FD_TARGET.match(target or ""):
            continue
        if writable_target(target):
            continue
        return refusal(target or token)
    return None


try:
    event = json.load(sys.stdin)
except (ValueError, json.JSONDecodeError):
    raise SystemExit(0)
tool_input = event.get("tool_input")
command = tool_input.get("command") if isinstance(tool_input, dict) else None
reason = verdict(command if isinstance(command, str) else None)
if reason:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
')
guard_rc=$?

if (( guard_rc != 0 )); then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse",'
  printf '"permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
    "сторож записи проверяющего узла не отработал (код $guard_rc) — сообщи человеку"
  exit 0
fi

[[ -z "$decision" ]] || printf '%s' "$decision"
exit 0
