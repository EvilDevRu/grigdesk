#!/usr/bin/env bash
# Доверенный курсор выполнения для попытки с закреплённым маршрутом v2.
#
# Публичный API:
#   attempt_stage_state_init_v2 TASK ATTEMPT_ID ROUTE_ID
#   attempt_stage_state_read_v2 TASK ATTEMPT_ID
#   attempt_stage_state_latest_event_v2 TASK ATTEMPT_ID
#   attempt_stage_state_pause_v2 TASK ATTEMPT_ID NODE REASON
#   attempt_stage_state_commit_v2 TASK ATTEMPT_ID NODE OUTCOME \
#     [HARD_REWIND_LIMIT] [VERDICT_B64] [NO_PROGRESS_LIMIT] [RECOVERY] \
#     [TARGET_BUDGET] [REJECT_FEEDBACK]
#
# Изменяемый курсор и его только дополняемый журнал событий с цепочкой хешей хранятся только в
# <control-root>/protocol-v2/tasks/t<TASK>/attempts/<ATTEMPT>/stage-results.
# Этот модуль намеренно не открывает и не изменяет старые файлы STATE_DIR/t*.pipeline.
#
# Коды возврата соответствуют attempt-state.sh:
#   2  неверные входные данные вызывающей стороны
#   73 курсор выполнения не инициализирован
#   75 устаревший CAS active-attempt/current-node/state
#   78 повреждённое состояние, бандл или переход либо небезопасный объект файловой системы

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-state.sh"

_attempt_stage_state_node_id() {
  _attempt_state_route_id "${1:-}"
}

_attempt_stage_state_outcome() {
  _attempt_state_route_id "${1:-}"
}

_attempt_stage_state_now() {
  local value
  if [[ -n "${ATTEMPT_STAGE_STATE_TIME_OVERRIDE:-}" ]]; then
    [[ "${FACTORY_TESTING:-0}" == 1 ]] || return 2
    value=$ATTEMPT_STAGE_STATE_TIME_OVERRIDE
  else
    value=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
  fi
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    return 2
  printf '%s\n' "$value"
}

_attempt_stage_state_json() {
  local operation=${1:?operation}
  shift
  python3 - "$operation" "$@" <<'PY'
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import sys

OP, *ARGS = sys.argv[1:]
ATTEMPT_RE = re.compile(r"^a_[a-f0-9]{32}$")
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
FINDING_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
TASK_RE = re.compile(r"^[1-9][0-9]{0,18}$")
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
EVENT_RE = re.compile(r"^event\.([0-9]{20})\.([a-f0-9]{64})\.json$")
DECLARED_STOP_TARGETS = {"human", "failed", "done"}
FAILURE_OWNERS = {"build", "tests", "environment", "plan", "human"}
# Вес замечания. Отсутствие поля читается как `blocking`: события, записанные до
# появления веса, остаются валидными и читаются одинаково — ledger immutable,
# мигрировать его нельзя.
SEVERITIES = {"blocking", "deferred"}
DEFAULT_SEVERITY = "blocking"
# rewind-limit — не исход опубликованного маршрута, а доверенная остановка движка:
# схема просила ещё один автоматический rewind, но этот же переход уже дважды не помог.
CURSOR_STOP_TARGETS = DECLARED_STOP_TARGETS | {"rewind-limit", "no-progress"}
HUMAN_RESUMABLE_STOP_TARGETS = {"human", "rewind-limit", "no-progress"}
# Коммит восстановления: диагностический узел закрыт `failed` не потому, что его
# исполнили, а потому что при подъёме после обрыва снята инструментация, на которой он
# стоял. Узел не работал, значит и указание человека к нему не отработано — по этой
# метке `human_rewind_note` отличает такой коммит от настоящего захода.
RECOVERY_COMMIT_REASON = "узел не исполнялся: при восстановлении снята инструментация"


def fail(code=78):
    raise SystemExit(code)


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail()


def shape(value, required, optional=()):
    # Как exact, но с необязательными ключами: ими вводятся anchor/reviewed, и
    # вердикты без них обязаны остаться валидными байт-в-байт.
    if not isinstance(value, dict):
        fail()
    keys = set(value)
    if not set(required) <= keys or not keys <= set(required) | set(optional):
        fail()


def artifact_path(value):
    # Якорь замечания и объявленный охват — относительные пути рабочего дерева.
    # Абсолютный путь и `..` отвергаются: путь используется только как метка для
    # сравнения наборов, но метка, притворяющаяся путём наружу, вводит в заблуждение.
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 200
        and not value.startswith("/")
        and ".." not in value.split("/")
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def identifier(value, regexp=ID_RE):
    if not isinstance(value, str) or not regexp.fullmatch(value):
        fail()
    return value


def integer(value, minimum=0):
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        fail()
    return value


def decimal(value, maximum):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        fail(2)
    parsed = int(value)
    if parsed > maximum:
        fail(2)
    return parsed


def timestamp(value):
    if not isinstance(value, str) or not TIME_RE.fullmatch(value):
        fail()
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        fail()
    return value


def reason(value):
    # Границы общие с lib/attempt-state.sh: многострочный текст до 20 000 символов,
    # из управляющих допустим только перевод строки. Функция валидирует и ЧТЕНИЕ
    # старых событий, поэтому ослабление обратносовместимо: однострочные причины
    # прежних журналов проходят как проходили.
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 20000
        or any(char != "\n" and (ord(char) < 32 or ord(char) == 127) for char in value)
    ):
        fail()
    return value


def is_recovery_commit(event):
    # У rejected тот же reason несёт человеческое замечание ворот. Даже если человек
    # дословно ввёл служебную константу восстановления, это всё ещё feedback: исход
    # однозначно отделяет решение ворот от внутреннего recovery-коммита.
    return (
        event.get("kind") == "commit"
        and event.get("outcome") != "rejected"
        and event.get("reason") == RECOVERY_COMMIT_REASON
    )


def event_at_sequence(directory, sequence):
    # runtime.lastCommit называет последовательность, но имя immutable-файла ещё
    # содержит hash. Для exact-idempotency нужен сам зафиксированный reason: сравнение
    # только node/outcome превращает повтор rejected с ДРУГИМ текстом в ложный успех.
    sequence = integer(sequence)
    try:
        names = os.listdir(directory)
    except OSError:
        fail()
    matches = []
    for name in names:
        match = EVENT_RE.fullmatch(name)
        if match and int(match.group(1)) == sequence:
            matches.append(name)
    if len(matches) != 1:
        fail()
    event = regular_json(os.path.join(directory, matches[0]))
    if not isinstance(event, dict) or event.get("sequence") != sequence:
        fail()
    return event


def finding_severity(finding):
    return finding.get("severity", DEFAULT_SEVERITY)


def blocking_findings(value):
    # Только блокирующие замечания возвращают работу автору и участвуют в сторожах
    # топтания. Отложенные едут хвостом до ворот приёмки и на маршрут не влияют.
    if value is None:
        return []
    return [
        finding
        for finding in value["findings"]
        if finding_severity(finding) == "blocking"
    ]


def record_finding(findings, node, sequence, verdict, finding, status):
    # Проекция ledger: одна запись на (узел, id). Повторное появление того же id
    # обновляет текст и статус, но сохраняет openedSequence — по нему видно, с
    # какого хода замечание живёт.
    key = (node, finding["id"])
    previous = findings.get(key)
    if previous is None or previous["status"] == "closed":
        findings[key] = {
            "id": finding["id"],
            "sourceNode": node,
            "owner": verdict["owner"],
            "summary": finding["summary"],
            "openedSequence": sequence,
            "lastSeenSequence": sequence,
            "status": status,
            "closedSequence": None,
        }
        return
    previous["owner"] = verdict["owner"]
    previous["summary"] = finding["summary"]
    previous["lastSeenSequence"] = sequence
    previous["status"] = status


def validate_verdict(value, outcome):
    if value is None:
        return None
    # `done` несёт вердикт только с отложенными находками: проверяющий принял работу
    # и приложил список того, что нашёл вне цели задачи. Блокирующее замечание при
    # `done` — противоречие, его отвергаем.
    if outcome not in {"failed", "done"}:
        fail()
    shape(value, {"owner", "findings"}, {"reviewed"})
    if value["owner"] not in FAILURE_OWNERS:
        fail()
    findings = value["findings"]
    if not isinstance(findings, list) or not 1 <= len(findings) <= 32:
        fail()
    seen = set()
    for finding in findings:
        shape(finding, {"id", "summary"}, {"anchor", "severity"})
        finding_id = finding["id"]
        summary = finding["summary"]
        if "severity" in finding and finding["severity"] not in SEVERITIES:
            fail()
        if (
            not isinstance(finding_id, str)
            or not FINDING_RE.fullmatch(finding_id)
            or finding_id in seen
            or not isinstance(summary, str)
            or not 1 <= len(summary) <= 500
            or any(ord(char) < 32 or ord(char) == 127 for char in summary)
        ):
            fail()
        if "anchor" in finding and not artifact_path(finding["anchor"]):
            fail()
        seen.add(finding_id)
    if outcome == "done" and blocking_findings(value):
        fail()
    # Охват прохода: что проверяющий фактически просмотрел. Поле необязательное,
    # но именно оно позволяет отличить первый проход по новому артефакту от
    # претензии к уже просмотренному — см. scope_expansion_reason.
    if "reviewed" in value:
        reviewed = value["reviewed"]
        if not isinstance(reviewed, list) or not 1 <= len(reviewed) <= 64:
            fail()
        if len(set(reviewed)) != len(reviewed):
            fail()
        for path in reviewed:
            if not artifact_path(path):
                fail()
    return value


def decode_verdict(encoded, outcome):
    if not encoded:
        return None
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded):
        fail(2)
    try:
        payload = base64.b64decode(encoded, validate=True)
        if len(payload) > 32 * 1024:
            fail(2)
        value = json.loads(payload.decode("utf-8"), parse_constant=lambda _: fail(2))
    except (ValueError, UnicodeError, json.JSONDecodeError):
        fail(2)
    validate_verdict(value, outcome)
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if canonical != payload:
        fail(2)
    return value


def verdict_snapshot(value):
    # Снимок вердикта для сторожа топтания: владелец + стабильные finding id.
    # Кортеж, а не строка-отпечаток: по строке видно только полное совпадение
    # наборов, а неснятую причину показывает их ПЕРЕСЕЧЕНИЕ. Со строкой смена
    # одного finding из четырёх читается прогрессом, и цикл законно ходит вокруг
    # одного и того же замечания, пока сопутствующие тасуются.
    if value is None:
        return None
    return (
        value["owner"],
        tuple(sorted(finding["id"] for finding in blocking_findings(value))),
    )


def canonical_bytes(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def digest_value(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def dump(value):
    json.dump(value, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
    sys.stdout.write("\n")


def regular_json(path, immutable=True):
    try:
        info = os.lstat(path)
    except OSError:
        fail()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail()
    if immutable and (stat.S_IMODE(info.st_mode) != 0o400 or info.st_nlink != 1):
        fail()
    try:
        with open(path, encoding="utf-8") as source:
            return json.load(source, parse_constant=lambda _: fail())
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail()


def validate_static(
    value,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
):
    if (
        value.get("schema") != 1
        or value.get("protocolVersion") != 2
        or value.get("taskId") != task
        or value.get("attemptId") != attempt
        or value.get("profile") != profile
        or value.get("catalogHash") != catalog
        or value.get("route") != route
        or value.get("routeHash") != route_hash
    ):
        fail()


def validate_last_commit(value, maximum):
    if value is None:
        return None
    exact(value, {"node", "outcome", "sequence"})
    identifier(value["node"])
    identifier(value["outcome"])
    sequence = integer(value["sequence"], 1)
    if sequence > maximum:
        fail()
    return value


def validate_cursor(value, maximum):
    exact(value, {"state", "currentNode", "stop", "pauseReason", "lastCommit"})
    state_value = value["state"]
    if state_value not in {"ready", "paused", "stopped"}:
        fail()
    validate_last_commit(value["lastCommit"], maximum)
    if state_value == "ready":
        identifier(value["currentNode"])
        if value["stop"] is not None or value["pauseReason"] is not None:
            fail()
    elif state_value == "paused":
        identifier(value["currentNode"])
        if value["stop"] is not None:
            fail()
        reason(value["pauseReason"])
    else:
        if value["currentNode"] is not None or value["pauseReason"] is not None:
            fail()
        if value["stop"] not in CURSOR_STOP_TARGETS:
            fail()
    return value


def validate_action(value):
    if not isinstance(value, dict):
        fail()
    modes = set(value) & {"next", "rewind", "stop", "escalate"}
    if len(modes) != 1:
        fail()
    mode = next(iter(modes))
    if mode == "next":
        exact(value, {"next"})
        identifier(value["next"])
    elif mode == "rewind":
        exact(value, {"rewind", "reset"})
        identifier(value["rewind"])
        reset = value["reset"]
        if (
            not isinstance(reset, list)
            or not reset
            or len(reset) != len(set(reset))
        ):
            fail()
        for item in reset:
            identifier(item)
        if reset[0] != value["rewind"]:
            fail()
    elif mode == "stop":
        exact(value, {"stop"})
        if value["stop"] not in DECLARED_STOP_TARGETS:
            fail()
    else:
        # Выбранный маршрут неизменяем на всём протяжении попытки. Для перехода
        # на другой маршрут нужен отдельный явный протокол выбора попытки/маршрута.
        fail()
    return mode


def derive_commit_cursor(before, action, node, outcome, sequence):
    mode = validate_action(action)
    last = {"node": node, "outcome": outcome, "sequence": sequence}
    if mode == "next":
        return {
            "state": "ready",
            "currentNode": action["next"],
            "stop": None,
            "pauseReason": None,
            "lastCommit": last,
        }
    if mode == "rewind":
        return {
            "state": "ready",
            "currentNode": action["rewind"],
            "stop": None,
            "pauseReason": None,
            "lastCommit": last,
        }
    return {
        "state": "stopped",
        "currentNode": None,
        "stop": action["stop"],
        "pauseReason": None,
        "lastCommit": last,
    }


def human_rewind_note(directory, node):
    # Указание, оставленное человеком при возврате курсора на узел. Живёт в журнале
    # попытки событием human-rewind либо причиной rejected-коммита ворот и обязано
    # доехать до промпта того захода, ради которого узел вернули: иначе человек жмёт
    # «перейти сюда»/«на доработку», агент входит с тем же заданием, что и в прошлый
    # раз, и повторяет ту же ошибку.
    # Снимается ПЕРВЫМ ЖЕ коммитом узла: указание отработано, и подсовывать его
    # следующему заходу — врать ему о том, зачем он здесь. Возврат туда же второй раз
    # кладёт новое событие со своей причиной, поэтому «последнее слово» всегда свежее.
    # Исключение — коммит восстановления: узел закрыт из-за снятой инструментации,
    # ни один агент его не открывал, и указание обязано дожить до настоящего захода.
    # Иначе выходит петля, которую и ловили на t7802: человек прикладывает решение,
    # жмёт «продолжить», подъём закрывает узел `failed` за отсутствующую разметку,
    # маршрут уводит на instrument — и обратно узел входит уже без решения.
    # reason() строгая: события пишутся через ту же валидацию, поэтому непроходной
    # текст здесь означает порчу журнала, а её нельзя проглатывать молча.
    identifier(node)
    try:
        names = os.listdir(directory)
    except OSError:
        fail()
    events = []
    for name in names:
        match = EVENT_RE.fullmatch(name)
        if match:
            events.append((int(match.group(1)), name))
    events.sort()
    note = ""
    for _, name in events:
        event = regular_json(os.path.join(directory, name))
        if not isinstance(event, dict):
            continue
        action = event.get("action")
        # Rejected фиксируется на самом gate, но адресовано указание агенту, куда
        # объявленный маршрутом next/rewind переводит курсор. Mutable gate-comment
        # при отдельном resume очищается reset-проекцией, поэтому источник здесь
        # только immutable commit-event.
        if (
            event.get("kind") == "commit"
            and event.get("outcome") == "rejected"
            and isinstance(action, dict)
            and (action.get("rewind") == node or action.get("next") == node)
            and event.get("reason") is not None
        ):
            note = reason(event.get("reason"))
            continue
        if event.get("node") != node:
            continue
        if event.get("kind") == "human-rewind":
            note = reason(event.get("reason"))
        elif is_recovery_commit(event):
            continue
        elif event.get("kind") in {"commit", "rewind-limit", "no-progress"}:
            note = ""
    return note


def automatic_rewind_verdicts(directory, node, target):
    # Возвращаем историю ЗАФИКСИРОВАННЫХ возвратов той же автономной дуги после
    # последнего решения человека — целыми вердиктами. Снимок (owner + стабильные
    # finding id) отвечает на вопрос «что не снялось», а объявленный охват и якоря
    # замечаний — на вопрос «видел ли проверяющий этот артефакт раньше». Границы
    # серии считаются здесь один раз, чтобы оба сторожа не разошлись в трактовке.
    identifier(node)
    identifier(target)
    try:
        names = os.listdir(directory)
    except OSError:
        fail()
    events = []
    for name in names:
        match = EVENT_RE.fullmatch(name)
        if match:
            events.append((int(match.group(1)), name))
    events.sort()
    verdicts = []
    for _, name in events:
        event = regular_json(os.path.join(directory, name))
        action = event.get("action")
        rejected_feedback = (
            event.get("kind") == "commit"
            and event.get("outcome") == "rejected"
            and isinstance(action, dict)
            and "rewind" in action
            # Для самой считаемой legacy-дуги rejected — обычный автоматический
            # rewind, а не граница истории. Граница возникает, когда человек на
            # другом gate возвращает маршрут к новой серии исправлений.
            and (
                event.get("node") != node
                or action.get("rewind") != target
            )
        )
        if event.get("kind") == "human-rewind" or rejected_feedback:
            # И явный goto, и rejected на human gate начинают новую автономную
            # серию: прежние findings не должны остановить исправление по новой
            # человеческой обратной связи.
            verdicts = []
            continue
        if (
            event.get("kind") == "commit"
            and event.get("node") == node
            and isinstance(action, dict)
            and action.get("rewind") == target
        ):
            verdict = event.get("verdict")
            validate_verdict(verdict, event.get("outcome"))
            verdicts.append(verdict)
    return verdicts


def automatic_rewind_count(directory, target):
    # Суммарный счёт АВТОМАТИЧЕСКИХ возвратов в один target за попытку —
    # последний предохранитель, не зависящий от поведения агента: ни typed
    # verdict, ни честность контракта приёмки, ни стабильность finding id на
    # него не влияют. Per-arc лимиты не ловят чередование дуг: на 8162 в build
    # шесть раз возвращал review и один раз lint, не исчерпав ни одной дуги.
    # В отличие от истории дуги, решение человека (human-rewind, rejected на
    # gate) счёт НЕ обнуляет — иначе «перезапустил серию» выдавал бы новый
    # бюджет; остановка по бюджету остаётся human-resumable, так что человеку
    # он не мешает, а безмолвная серия кругов обрывается.
    identifier(target)
    try:
        names = os.listdir(directory)
    except OSError:
        fail()
    events = []
    for name in names:
        match = EVENT_RE.fullmatch(name)
        if match:
            events.append((int(match.group(1)), name))
    events.sort()
    count = 0
    for _, name in events:
        event = regular_json(os.path.join(directory, name))
        action = event.get("action")
        if (
            event.get("kind") == "commit"
            # Rejected на human gate — решение человека, а не автоматический
            # возврат: его закрывает сам факт новой человеческой обратной связи.
            and event.get("outcome") != "rejected"
            and isinstance(action, dict)
            and action.get("rewind") == target
        ):
            count += 1
    return count


def stable_core_reason(window, owner):
    # Замечание, пережившее каждый ремонт окна. Наборы при этом не совпадают,
    # поэтому проверки повтора и осцилляции молчат, — а цикл уже доказал, что
    # эту причину он снять не умеет: ровно так расследование крутится вокруг
    # неотделённой первопричины, пока сопутствующие findings меняются.
    if any(item[0] != owner for item in window):
        return None
    core = set(window[0][1])
    for item in window[1:]:
        core &= set(item[1])
    if not core:
        return None
    # Прогрессом считается только сужение, затрагивающее само ядро. Ядро —
    # пересечение окна, поэтому его элементы пережили КАЖДЫЙ ремонт серии, и
    # сужение за их счёт невозможно по построению: отброшенный хвост
    # сопутствующих замечаний прогрессом не считается. Правило «строгое сужение =
    # прогресс» разоружило сторож на 8162: ревью закрыло сопутствующее замечание
    # при живом ядре, подозрение снялось, и цикл пошёл на новый круг.
    # reason() ограничен 500 символами, а findings бывает до 32: перечисляем
    # первые три и говорим, сколько осталось, — иначе длинное ядро уронило бы
    # запись события, то есть сторож ломал бы то, что охраняет.
    names = sorted(core)
    shown = ", ".join(names[:3])
    if len(names) > 3:
        shown += f" и ещё {len(names) - 3}"
    return f"ремонт не снимает замечания: {shown}"


def scope_expansion_reason(history, candidate):
    # Первый typed verdict после решения человека замыкает блокирующий набор дуги.
    # Иначе проверяющий может каждый раз приносить полностью новые id: точный
    # no-progress fingerprint считает это прогрессом, хотя задача только растёт.
    # Один ремонт замкнутого набора тоже является пределом автоматической автономии:
    # если следующий verdict оставил тот же owner + ids, дальнейшее уточнение summary
    # не доказывает прогресс и требует решения человека.
    # Причинность нового дефекта ledger доказать не может, поэтому безопасный исход —
    # остановить автоматический rewind и отдать расширение человеку, не потеряв verdict.
    # Единственное исключение — ниже: первый проход по артефакту, которого проверяющий
    # раньше не видел. Аргументы — целые вердикты, а не снимки: снимок отвечает
    # «что не снялось», а якоря и охват — «видел ли он этот артефакт».
    if candidate is None:
        return None
    typed_history = [verdict for verdict in history if verdict is not None]
    if not typed_history:
        return None
    candidate_snapshot = verdict_snapshot(candidate)
    if candidate_snapshot == verdict_snapshot(typed_history[-1]):
        return "повторяется тот же набор открытых замечаний после одного ремонта"
    closed_owner, closed_ids = verdict_snapshot(typed_history[0])
    owner, candidate_ids = candidate_snapshot
    if owner != closed_owner:
        return (
            "замкнутый набор замечаний сменил владельца: "
            f"{closed_owner} → {owner}"
        )
    added = sorted(set(candidate_ids) - set(closed_ids))
    if not added:
        return None
    # Ремонт замкнутого набора обычно и создаёт новые артефакты: закрыть замечание
    # «сценарий не покрыт» нельзя, не написав файл. Замечание по такому файлу — первый
    # проход по новому коду, а не рост охвата: раньше его не могло быть, потому что
    # файла не существовало. Такой id не удерживает маршрут у человека — возврат
    # уходит обычным автоматическим, списываясь из общего бюджета попытки.
    # Отсев работает ТОЛЬКО когда прошлые вердикты серии объявили охват: без него
    # «не видел раньше» неотличимо от «не потрудился посмотреть», и правило пропускало
    # бы любой новый id, то есть отменяло бы само себя.
    reviewed = set()
    for verdict in typed_history:
        reviewed.update(verdict.get("reviewed") or ())
    if reviewed:
        anchors = {
            finding["id"]: finding.get("anchor")
            for finding in candidate["findings"]
        }
        added = [
            finding_id
            for finding_id in added
            if not (
                anchors.get(finding_id)
                and anchors[finding_id] not in reviewed
            )
        ]
        if not added:
            return None
    shown = ", ".join(added[:3])
    if len(added) > 3:
        shown += f" и ещё {len(added) - 3}"
    return f"замкнутый набор замечаний расширен новыми id: {shown}"


def no_progress_reason(history, candidate, limit):
    if candidate is None or not limit:
        return None
    snapshots = history + [candidate]

    # Тот же набор finding id повторился limit+1 раз подряд: ремонт не меняет
    # наблюдаемое состояние проверяющего.
    repeated = 0
    for snapshot in reversed(snapshots):
        if snapshot != candidate:
            break
        repeated += 1
    if repeated >= limit + 1:
        return "повторяется тот же набор открытых замечаний"

    # Частая в ревью осцилляция: A исправили ценой B, затем вернули A и так далее.
    # Пять точек достаточно, чтобы отличить цикл A→B→A→B→A от одного полезного
    # пересмотра. Общий hard limit остаётся последним предохранителем иных циклов.
    if (
        len(snapshots) >= 5
        and snapshots[-1] == snapshots[-3] == snapshots[-5]
        and snapshots[-2] == snapshots[-4]
        and snapshots[-1] != snapshots[-2]
    ):
        return "обнаружена осцилляция двух наборов замечаний"

    if len(snapshots) >= limit + 1:
        return stable_core_reason(snapshots[-(limit + 1):], candidate[0])
    return None


def validate_event_static(
    event,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
):
    required = {
            "schema",
            "protocolVersion",
            "taskId",
            "attemptId",
            "profile",
            "catalogHash",
            "route",
            "routeHash",
            "sequence",
            "at",
            "kind",
            "node",
            "outcome",
            "reason",
            "action",
            "previousEventHash",
            "before",
            "after",
        }
    # `verdict` добавлен совместимо: старые immutable events остаются валидны,
    # новые commit-events могут нести проверенную типизацию failed.
    if not isinstance(event, dict) or frozenset(event) not in {
        frozenset(required),
        frozenset(required | {"verdict"}),
    }:
        fail()
    validate_static(
        event,
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
    )
    integer(event["sequence"])
    timestamp(event["at"])
    identifier(event["node"])
    validate_verdict(event.get("verdict"), event.get("outcome"))
    if event["kind"] not in {
        "init", "pause", "commit", "human-rewind", "rewind-limit", "no-progress"
    }:
        fail()


def validate_runtime(
    runtime,
    task,
    attempt,
    profile,
    catalog,
    route,
    route_hash,
    entry,
):
    exact(
        runtime,
        {
            "schema",
            "protocolVersion",
            "taskId",
            "attemptId",
            "profile",
            "catalogHash",
            "route",
            "routeHash",
            "entry",
            "sequence",
            "headEventHash",
            "cursor",
        },
    )
    validate_static(
        runtime,
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
    )
    if runtime["entry"] != entry:
        fail()
    integer(runtime["sequence"])
    identifier(runtime["headEventHash"], HASH_RE)
    validate_cursor(runtime["cursor"], runtime["sequence"])
    return runtime


def event_base(runtime, sequence, at, kind, node):
    return {
        "schema": 1,
        "protocolVersion": 2,
        "taskId": runtime["taskId"],
        "attemptId": runtime["attemptId"],
        "profile": runtime["profile"],
        "catalogHash": runtime["catalogHash"],
        "route": runtime["route"],
        "routeHash": runtime["routeHash"],
        "sequence": sequence,
        "at": timestamp(at),
        "kind": kind,
        "node": identifier(node),
        "previousEventHash": runtime["headEventHash"],
    }


def validate_transition(value, runtime, node, outcome, failure_owner):
    required = {
            "schema",
            "catalogHash",
            "route",
            "routeHash",
            "node",
            "outcome",
            "action",
            "retry",
            "escalationPolicy",
        }
    if not isinstance(value, dict) or frozenset(value) not in {
        frozenset(required),
        frozenset(required | {"failureOwner"}),
    }:
        fail()
    if (
        value["schema"] != 2
        or value["catalogHash"] != runtime["catalogHash"]
        or value["route"] != runtime["route"]
        or value["routeHash"] != runtime["routeHash"]
        or value["node"] != node
        or value["outcome"] != outcome
        or value["escalationPolicy"] is not None
        or value.get("failureOwner") != failure_owner
    ):
        fail()
    validate_action(value["action"])
    return value["action"]


if OP == "parse-description":
    path, profile, catalog, route, route_hash = ARGS
    value = regular_json(path, immutable=False)
    exact(
        value,
        {"schema", "profile", "catalogHash", "route", "routeHash", "machine"},
    )
    if (
        value["schema"] != 2
        or value["profile"] != profile
        or value["catalogHash"] != catalog
        or value["route"] != route
        or value["routeHash"] != route_hash
    ):
        fail()
    machine = value["machine"]
    if not isinstance(machine, dict):
        fail()
    sys.stdout.write(identifier(machine.get("entry")) + "\n")

elif OP == "assert-empty":
    (directory,) = ARGS
    try:
        info = os.lstat(directory)
        entries = os.listdir(directory)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o700
        or entries
    ):
        fail()

elif OP == "make-init":
    task, attempt, profile, catalog, route, route_hash, entry, at = ARGS
    identifier(task, TASK_RE)
    identifier(attempt, ATTEMPT_RE)
    identifier(profile, PROFILE_RE)
    identifier(catalog, HASH_RE)
    identifier(route)
    identifier(route_hash, HASH_RE)
    identifier(entry)
    cursor = {
        "state": "ready",
        "currentNode": entry,
        "stop": None,
        "pauseReason": None,
        "lastCommit": None,
    }
    dump(
        {
            "schema": 1,
            "protocolVersion": 2,
            "taskId": task,
            "attemptId": attempt,
            "profile": profile,
            "catalogHash": catalog,
            "route": route,
            "routeHash": route_hash,
            "sequence": 0,
            "at": timestamp(at),
            "kind": "init",
            "node": entry,
            "outcome": None,
            "reason": None,
            "action": {"next": entry},
            "previousEventHash": None,
            "before": None,
            "after": cursor,
        }
    )

elif OP == "runtime-from-event":
    event_path, event_hash, entry = ARGS
    event = regular_json(event_path)
    identifier(event_hash, HASH_RE)
    if hashlib.sha256(open(event_path, "rb").read()).hexdigest() != event_hash:
        fail()
    dump(
        {
            "schema": event["schema"],
            "protocolVersion": event["protocolVersion"],
            "taskId": event["taskId"],
            "attemptId": event["attemptId"],
            "profile": event["profile"],
            "catalogHash": event["catalogHash"],
            "route": event["route"],
            "routeHash": event["routeHash"],
            "entry": identifier(entry),
            "sequence": event["sequence"],
            "headEventHash": event_hash,
            "cursor": event["after"],
        }
    )

elif OP == "make-envelope":
    (runtime_path,) = ARGS
    runtime = regular_json(runtime_path)
    dump({"checksum": digest_value(runtime), "runtime": runtime})

elif OP == "prepare-pause":
    runtime_path, node, pause_reason, at = ARGS
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    reason(pause_reason)
    if (
        cursor.get("state") == "paused"
        and cursor.get("currentNode") == node
        and cursor.get("pauseReason") == pause_reason
    ):
        fail(10)
    if cursor.get("state") != "ready" or cursor.get("currentNode") != node:
        fail(75)
    sequence = integer(runtime.get("sequence")) + 1
    event = event_base(runtime, sequence, at, "pause", node)
    event.update(
        {
            "outcome": None,
            "reason": pause_reason,
            "action": None,
            "before": cursor,
            "after": {
                "state": "paused",
                "currentNode": node,
                "stop": None,
                "pauseReason": pause_reason,
                "lastCommit": cursor.get("lastCommit"),
            },
        }
    )
    dump(event)

elif OP == "prepare-human-rewind":
    runtime_path, results_dir, node, reset_csv, rewind_reason, at = ARGS
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    reason(rewind_reason)
    reset = [item for item in reset_csv.split(",") if item]
    if not reset or len(reset) != len(set(reset)) or reset[0] != node:
        fail()
    for item in reset:
        identifier(item)
    # Остановка `stop: human|rewind-limit|no-progress` означает «маршрут ждёт решения
    # человека», и возврат курсора — законное решение (провайдер лежал или одинаковый
    # автоматический возврат уже дважды не помог).
    # Терминальные done/failed закрывают попытку: их разбирают abandon/recover.
    if (
        cursor.get("state") == "stopped"
        and cursor.get("stop") not in HUMAN_RESUMABLE_STOP_TARGETS
    ):
        fail(75)
    # Возврат несёт ДВЕ вещи: курсор и указание человека. Курсор может уже стоять там,
    # указание — нет, и раньше такой заход считался пустым: событие не ложилось, а
    # `factory goto` всё равно печатал «курсор возвращён» и отвечал успехом. На t7802
    # так пропало решение владельца, набранное в «перейти сюда» на текущем узле, —
    # заход диагностики ушёл без него. Гасим только настоящий повтор (тот же узел и
    # ровно то же указание, ещё не отработанное коммитом) — как в prepare-pause.
    if (
        cursor.get("currentNode") == node
        and cursor.get("state") == "ready"
        and human_rewind_note(results_dir, node) == rewind_reason
    ):
        fail(10)
    sequence = integer(runtime.get("sequence")) + 1
    event = event_base(runtime, sequence, at, "human-rewind", node)
    event.update(
        {
            "outcome": None,
            "reason": rewind_reason,
            "action": {"rewind": node, "reset": reset},
            "before": cursor,
            "after": {
                "state": "ready",
                "currentNode": node,
                "stop": None,
                "pauseReason": None,
                "lastCommit": cursor.get("lastCommit"),
            },
        }
    )
    dump(event)

elif OP == "prepare-commit":
    (
        runtime_path,
        transition_path,
        results_dir,
        node,
        outcome,
        at,
        rewind_limit_raw,
        verdict_b64,
        no_progress_limit_raw,
        recovery_raw,
        target_budget_raw,
        feedback_raw,
    ) = ARGS
    if recovery_raw not in {"0", "1"}:
        fail()
    runtime = regular_json(runtime_path)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    identifier(node)
    identifier(outcome)
    last = cursor.get("lastCommit")
    # Идемпотентность существует ради ОДНОГО случая: коммит лёг в журнал, процесс умер
    # до того, как увидел успех, и повтор не должен класть второе событие. Возврат
    # курсора человеком — не этот случай: человек вернул узел ЗНАЯ его прошлый исход и
    # прося переиграть, поэтому «тот же исход» здесь законен и обязан лечь событием.
    # Иначе курсор не двигается, а диспетчер видит тот же узел готовым и гоняет по нему
    # агента до потолка шагов — деньгами и часами за отказ записать один факт.
    # После нового коммита узла возврат перестаёт считаться свежим, и повтор упавшего
    # процесса снова гасится идемпотентностью — ровно как задумано.
    same_last_commit = (
        isinstance(last, dict)
        and last.get("node") == node
        and last.get("outcome") == outcome
    )
    if same_last_commit and outcome == "rejected":
        # Crash-retry допустим только пока lastCommit является последним событием и
        # только с дословно тем же feedback. Иначе UI мог бы показать новый текст,
        # хотя immutable ledger сохранил старый. Если курсор позже явно вернули на те
        # же ворота, это уже новое решение, а не retry старого CAS.
        if integer(runtime.get("sequence")) == integer(last.get("sequence"), 1):
            committed = event_at_sequence(results_dir, last.get("sequence"))
            requested_reason = feedback_raw if feedback_raw else None
            if committed.get("reason") != requested_reason:
                fail(75)
            fail(10)
        if cursor.get("currentNode") != node:
            fail(75)
    if same_last_commit and not human_rewind_note(results_dir, node):
        fail(10)
    if cursor.get("state") not in {"ready", "paused"} or cursor.get("currentNode") != node:
        fail(75)
    verdict = decode_verdict(verdict_b64, outcome)
    # Тот же инвариант, что и на стороне bash: владелец участвует в выборе перехода
    # только у отказа. Вердикт приёмки с отложенным хвостом ветку не меняет.
    failure_owner = (
        verdict["owner"] if verdict is not None and outcome == "failed" else None
    )
    transition = regular_json(transition_path, immutable=False)
    action = validate_transition(
        transition,
        runtime,
        node,
        outcome,
        failure_owner,
    )
    rewind_limit = decimal(rewind_limit_raw, 10)
    no_progress_limit = decimal(no_progress_limit_raw, 10)
    target_budget = decimal(target_budget_raw, 10)
    sequence = integer(runtime.get("sequence")) + 1
    event_kind = "commit"
    action_mode = validate_action(action)
    # Метка восстановления и замечание rejected-ворот используют reason, но
    # взаимоисключаются по исходу. Rejected→stop тоже сохраняет комментарий для
    # аудита; доставить его следующему узлу можно только при объявленном rewind.
    if feedback_raw:
        if outcome != "rejected" or recovery_raw != "0":
            fail(2)
        event_reason = reason(feedback_raw)
    else:
        # Метка восстановления живёт только на обычном коммите: остановки
        # rewind-limit и no-progress называют себя сами и всё равно зовут человека.
        event_reason = RECOVERY_COMMIT_REASON if recovery_raw == "1" else None
    after = derive_commit_cursor(cursor, action, node, outcome, sequence)
    if action_mode == "rewind":
        rewind_verdicts = automatic_rewind_verdicts(
            results_dir,
            node,
            action["rewind"],
        )
        rewind_history = [verdict_snapshot(item) for item in rewind_verdicts]
        candidate_snapshot = verdict_snapshot(verdict)
        progress_reason = None
        if no_progress_limit:
            progress_reason = scope_expansion_reason(
                rewind_verdicts,
                verdict,
            )
        if progress_reason is None:
            progress_reason = no_progress_reason(
                rewind_history,
                candidate_snapshot,
                no_progress_limit,
            )
        if progress_reason is not None:
            event_kind = "no-progress"
            event_reason = (
                f"автоматический возврат остановлен без прогресса: {node} → "
                f"{action['rewind']}; {progress_reason}"
            )
            after = {
                "state": "stopped",
                "currentNode": None,
                "stop": "no-progress",
                "pauseReason": None,
                "lastCommit": {
                    "node": node,
                    "outcome": outcome,
                    "sequence": sequence,
                },
            }
        elif rewind_limit and len(rewind_history) >= rewind_limit:
            event_kind = "rewind-limit"
            event_reason = (
                f"автоматический лимит возвратов исчерпан: {node} → "
                f"{action['rewind']}; уже выполнено {rewind_limit}"
            )
            after = {
                "state": "stopped",
                "currentNode": None,
                "stop": "rewind-limit",
                "pauseReason": None,
                "lastCommit": {
                    "node": node,
                    "outcome": outcome,
                    "sequence": sequence,
                },
            }
        elif target_budget and (
            automatic_rewind_count(results_dir, action["rewind"]) >= target_budget
        ):
            # Последний предохранитель: срабатывает после no-progress и лимита
            # дуги, чтобы их конкретные причины не тонули в общем бюджете.
            event_kind = "rewind-limit"
            event_reason = (
                f"суммарный бюджет автоматических возвратов исчерпан за попытку: "
                f"{node} → {action['rewind']}; уже выполнено {target_budget}"
            )
            after = {
                "state": "stopped",
                "currentNode": None,
                "stop": "rewind-limit",
                "pauseReason": None,
                "lastCommit": {
                    "node": node,
                    "outcome": outcome,
                    "sequence": sequence,
                },
            }
    event = event_base(runtime, sequence, at, event_kind, node)
    event.update(
        {
            "outcome": outcome,
            "reason": event_reason,
            "action": action,
            "before": cursor,
            "after": after,
        }
    )
    if verdict is not None:
        event["verdict"] = verdict
    dump(event)

elif OP == "event-sequence":
    (event_path,) = ARGS
    event = regular_json(event_path)
    sys.stdout.write(str(integer(event.get("sequence"))) + "\n")

elif OP == "project-runtime":
    (runtime_path,) = ARGS
    runtime = regular_json(runtime_path, immutable=False)
    cursor = runtime.get("cursor")
    if not isinstance(cursor, dict):
        fail()
    dump(
        {
            "schema": runtime.get("schema"),
            "protocolVersion": runtime.get("protocolVersion"),
            "taskId": runtime.get("taskId"),
            "attemptId": runtime.get("attemptId"),
            "profile": runtime.get("profile"),
            "catalogHash": runtime.get("catalogHash"),
            "routeId": runtime.get("route"),
            "routeHash": runtime.get("routeHash"),
            "entryNode": runtime.get("entry"),
            "eventSequence": runtime.get("sequence"),
            "headEventHash": runtime.get("headEventHash"),
            "state": cursor.get("state"),
            "currentNode": cursor.get("currentNode"),
            "stop": cursor.get("stop"),
            "pauseReason": cursor.get("pauseReason"),
            "lastCommit": cursor.get("lastCommit"),
        }
    )

elif OP == "human-note":
    # Указание, оставленное человеком при возврате курсора на узел. Живёт в журнале
    # попытки событием human-rewind и обязано доехать до промпта того захода, ради
    # которого узел и вернули. Правила — в human_rewind_note().
    directory, node = ARGS
    note = human_rewind_note(directory, node)
    if note:
        sys.stdout.write(note + "\n")

elif OP == "findings-ledger":
    (directory,) = ARGS
    try:
        names = sorted(
            name for name in os.listdir(directory) if EVENT_RE.fullmatch(name)
        )
    except OSError:
        fail()
    findings = {}
    for name in names:
        event = regular_json(os.path.join(directory, name))
        if event.get("kind") not in {"commit", "rewind-limit", "no-progress"}:
            continue
        node = identifier(event.get("node"))
        outcome = event.get("outcome")
        identifier(outcome)
        sequence = integer(event.get("sequence"), 1)
        verdict = validate_verdict(event.get("verdict"), outcome)
        open_for_node = {
            key
            for key, finding in findings.items()
            if finding["sourceNode"] == node and finding["status"] == "open"
        }
        def record(finding, status):
            record_finding(findings, node, sequence, verdict, finding, status)

        if outcome == "done":
            for key in open_for_node:
                findings[key]["status"] = "closed"
                findings[key]["closedSequence"] = sequence
            # Приёмка с хвостом: работа принята, но проверяющий приложил список
            # находок вне цели задачи. Их нельзя ни закрывать (никто не чинил),
            # ни держать открытыми (возврат по ним запрещён) — отдельный статус.
            if verdict is not None:
                for finding in verdict["findings"]:
                    record(finding, "deferred")
            continue
        if outcome != "failed" or verdict is None:
            # Legacy failed не несёт полного набора замечаний: по нему нельзя
            # доказать ни открытие, ни закрытие finding.
            continue
        # Закрытие по исчезновению из набора считаем только по блокирующим: они
        # и есть предмет ремонта. Отложенная находка из набора не «пропадает».
        current_keys = {
            (node, finding["id"])
            for finding in blocking_findings(verdict)
        }
        for key in open_for_node - current_keys:
            findings[key]["status"] = "closed"
            findings[key]["closedSequence"] = sequence
        for finding in verdict["findings"]:
            record(
                finding,
                "open" if finding_severity(finding) == "blocking" else "deferred",
            )
    ordered = sorted(
        findings.values(),
        key=lambda item: (item["sourceNode"], item["id"]),
    )
    dump(
        {
            "schema": 1,
            "open": [item for item in ordered if item["status"] == "open"],
            "closed": [item for item in ordered if item["status"] == "closed"],
            "deferred": [item for item in ordered if item["status"] == "deferred"],
        }
    )

elif OP == "work-time":
    # Производная проекция immutable events: сколько секунд проработал каждый
    # узел. Интервал [предыдущее событие -> коммит] относится к узлу коммита,
    # поэтому повторные заходы после rewind накапливаются, а pause и human-rewind
    # получают ноль (это время ворот и человека). Коммит восстановления не
    # получает интервала и обрывает его: простой между обрывом и подъёмом — не
    # работа узла. Классификация узлов (ворота ли это) сюда не поднимается:
    # executor знает только вызывающая сторона по pinned describe-route.
    (directory,) = ARGS
    try:
        names = sorted(
            name for name in os.listdir(directory) if EVENT_RE.fullmatch(name)
        )
    except OSError:
        fail()
    per_node = {}
    previous_at = None
    last_at = None
    for name in names:
        event = regular_json(os.path.join(directory, name))
        at = int(
            datetime.datetime.strptime(
                timestamp(event.get("at")), "%Y-%m-%dT%H:%M:%SZ"
            )
            .replace(tzinfo=datetime.timezone.utc)
            .timestamp()
        )
        if (
            event.get("kind") in {"commit", "rewind-limit", "no-progress"}
            and not is_recovery_commit(event)
            and previous_at is not None
        ):
            node = identifier(event.get("node"))
            per_node[node] = per_node.get(node, 0) + max(0, at - previous_at)
        previous_at = at
        last_at = at
    dump({"schema": 1, "nodes": per_node, "lastEventAt": last_at})

elif OP == "validate-ledger":
    directory, task, attempt, profile, catalog, route, route_hash, entry = ARGS
    identifier(task, TASK_RE)
    identifier(attempt, ATTEMPT_RE)
    identifier(profile, PROFILE_RE)
    identifier(catalog, HASH_RE)
    identifier(route)
    identifier(route_hash, HASH_RE)
    identifier(entry)
    try:
        dir_info = os.lstat(directory)
        names = os.listdir(directory)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(dir_info.st_mode)
        or stat.S_ISLNK(dir_info.st_mode)
        or stat.S_IMODE(dir_info.st_mode) != 0o700
    ):
        fail()
    if "runtime.json" not in names:
        fail(73)
    event_names = []
    for name in names:
        path = os.path.join(directory, name)
        try:
            info = os.lstat(path)
        except OSError:
            fail()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o400
            or info.st_nlink != 1
        ):
            fail()
        if name == "runtime.json":
            continue
        match = EVENT_RE.fullmatch(name)
        if not match:
            fail()
        event_names.append((int(match.group(1)), match.group(2), name))
    event_names.sort()
    if not event_names or event_names[0][0] != 0:
        fail()

    previous_hash = None
    cursor = None
    for expected_sequence, (sequence, file_hash, name) in enumerate(event_names):
        if sequence != expected_sequence:
            fail()
        path = os.path.join(directory, name)
        try:
            raw = open(path, "rb").read()
        except OSError:
            fail()
        if hashlib.sha256(raw).hexdigest() != file_hash:
            fail()
        event = regular_json(path)
        validate_event_static(
            event,
            task,
            attempt,
            profile,
            catalog,
            route,
            route_hash,
        )
        if event["sequence"] != sequence or event["previousEventHash"] != previous_hash:
            fail()
        if sequence == 0:
            expected_cursor = {
                "state": "ready",
                "currentNode": entry,
                "stop": None,
                "pauseReason": None,
                "lastCommit": None,
            }
            if (
                event["kind"] != "init"
                or event["node"] != entry
                or event["outcome"] is not None
                or event["reason"] is not None
                or event["action"] != {"next": entry}
                or event["before"] is not None
                or event["after"] != expected_cursor
            ):
                fail()
        else:
            if event["before"] != cursor:
                fail()
            validate_cursor(cursor, sequence - 1)
            # Человеческий возврат — единственное событие, которое законно
            # УКАЗЫВАЕТ на другой узел: остальные описывают текущий.
            if event["kind"] != "human-rewind" and event["node"] != cursor["currentNode"]:
                fail()
            if event["kind"] == "human-rewind":
                # Возврат допустим из живого курсора и из остановки «ждёт человека»:
                # именно её человек и разрешает своим решением.
                if (
                    (
                        cursor["state"] == "stopped"
                        and cursor.get("stop") not in HUMAN_RESUMABLE_STOP_TARGETS
                    )
                    or event["outcome"] is not None
                    or not isinstance(event["action"], dict)
                    or set(event["action"]) != {"rewind", "reset"}
                    or event["action"]["rewind"] != event["node"]
                ):
                    fail()
                reason(event["reason"])
                expected_cursor = {
                    "state": "ready",
                    "currentNode": event["node"],
                    "stop": None,
                    "pauseReason": None,
                    "lastCommit": cursor["lastCommit"],
                }
                if event["after"] != expected_cursor:
                    fail()
            elif event["kind"] == "pause":
                if (
                    cursor["state"] != "ready"
                    or event["outcome"] is not None
                    or event["action"] is not None
                ):
                    fail()
                reason(event["reason"])
                expected_cursor = {
                    "state": "paused",
                    "currentNode": event["node"],
                    "stop": None,
                    "pauseReason": event["reason"],
                    "lastCommit": cursor["lastCommit"],
                }
                if event["after"] != expected_cursor:
                    fail()
            elif event["kind"] == "commit":
                # Обычно коммит объясняет себя исходом. Два строго различимых
                # исключения: константа recovery и bounded reason у rejected. При
                # rewind это ещё и замечание человека целевому узлу; при stop —
                # неизменяемый аудит причины остановки.
                if cursor["state"] not in {"ready", "paused"}:
                    fail()
                identifier(event["outcome"])
                commit_mode = validate_action(event["action"])
                if event["reason"] is not None:
                    if event["reason"] == RECOVERY_COMMIT_REASON:
                        pass
                    elif event["outcome"] == "rejected":
                        reason(event["reason"])
                    else:
                        fail()
                expected_cursor = derive_commit_cursor(
                    cursor,
                    event["action"],
                    event["node"],
                    event["outcome"],
                    sequence,
                )
                if event["after"] != expected_cursor:
                    fail()
            elif event["kind"] in {"rewind-limit", "no-progress"}:
                if cursor["state"] not in {"ready", "paused"}:
                    fail()
                identifier(event["outcome"])
                reason(event["reason"])
                if validate_action(event["action"]) != "rewind":
                    fail()
                expected_cursor = {
                    "state": "stopped",
                    "currentNode": None,
                    "stop": event["kind"],
                    "pauseReason": None,
                    "lastCommit": {
                        "node": event["node"],
                        "outcome": event["outcome"],
                        "sequence": sequence,
                    },
                }
                if event["after"] != expected_cursor:
                    fail()
            else:
                fail()
        validate_cursor(event["after"], sequence)
        cursor = event["after"]
        previous_hash = file_hash

    pointer = regular_json(os.path.join(directory, "runtime.json"))
    exact(pointer, {"checksum", "runtime"})
    identifier(pointer["checksum"], HASH_RE)
    if pointer["checksum"] != digest_value(pointer["runtime"]):
        fail()
    runtime = validate_runtime(
        pointer["runtime"],
        task,
        attempt,
        profile,
        catalog,
        route,
        route_hash,
        entry,
    )
    if (
        runtime["sequence"] != event_names[-1][0]
        or runtime["headEventHash"] != previous_hash
        or runtime["cursor"] != cursor
    ):
        fail()
    dump(runtime)

else:
    fail(2)
PY
}

# Заполняет глобальные ASTAGE_* после проверки активной попытки, неизменяемых пинов,
# терминального состояния, выбранного маршрута и самого закреплённого бандла.
_attempt_stage_state_load_locked() {
  local task=$1 attempt=$2 expected_route=${3:-}
  local root dir profile routes catalog route_pin route route_hash
  local terminal_rc description entry rc

  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_protocol_locked "$root" || return
  _attempt_state_require_active_locked "$root" "$task" "$attempt" >/dev/null || return
  dir=$(_attempt_state_validate_attempt_locked "$root" "$task" "$attempt") || return
  profile=$(_attempt_state_json get "$dir/attempt.json" profile) || return
  routes=$(_attempt_state_json get "$dir/attempt.json" routesDir) || return
  catalog=$(_attempt_state_json get "$dir/attempt.json" catalogHash) || return
  _attempt_state_routes_dir "$routes" >/dev/null || return 78
  _attempt_state_validate_pins_locked \
    "$dir" "$task" "$attempt" "$profile" "$catalog" || return

  _attempt_state_terminal_locked "$dir" "$task" "$attempt" >/dev/null
  terminal_rc=$?
  if (( terminal_rc == 0 )); then
    return 75
  elif (( terminal_rc != 3 )); then
    return "$terminal_rc"
  fi

  route_pin=$(_attempt_state_route_pin_locked \
    "$dir" "$task" "$attempt" "$profile" "$catalog")
  rc=$?
  (( rc == 0 )) || {
    (( rc == 3 )) && return 73
    return "$rc"
  }
  route=$(_attempt_state_json get "$route_pin" routeId) || return
  route_hash=$(_attempt_state_json get "$route_pin" routeHash) || return
  if [[ -n "$expected_route" && "$expected_route" != "$route" ]]; then
    return 75
  fi

  description=$(mktemp "$dir/.route-description.XXXXXX") || return 1
  "$(_attempt_state_route_tool)" \
    --routes-dir "$routes" \
    --profile "$profile" \
    describe-route \
    --catalog-hash "$catalog" \
    --route "$route" >"$description"
  rc=$?
  if (( rc == 0 )); then
    entry=$(_attempt_stage_state_json parse-description \
      "$description" "$profile" "$catalog" "$route" "$route_hash")
    rc=$?
  fi
  rm -f -- "$description"
  (( rc == 0 )) || return "$rc"

  ASTAGE_ROOT=$root
  ASTAGE_ATTEMPT_DIR=$dir
  ASTAGE_RESULTS_DIR="$dir/stage-results"
  ASTAGE_PROFILE=$profile
  ASTAGE_ROUTES_DIR=$routes
  ASTAGE_CATALOG_HASH=$catalog
  ASTAGE_ROUTE=$route
  ASTAGE_ROUTE_HASH=$route_hash
  ASTAGE_ENTRY=$entry
  [[ -d "$ASTAGE_RESULTS_DIR" && ! -L "$ASTAGE_RESULTS_DIR" ]] || return 78
}

_attempt_stage_state_validate_internal_locked() {
  _attempt_stage_state_json validate-ledger \
    "$ASTAGE_RESULTS_DIR" \
    "$1" "$2" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" \
    "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" "$ASTAGE_ENTRY"
}

_attempt_stage_state_validate_locked() {
  local task=$1 attempt=$2 runtime_tmp rc
  runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-output.XXXXXX") || return 1
  _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_json project-runtime "$runtime_tmp"
    rc=$?
  fi
  rm -f -- "$runtime_tmp"
  return "$rc"
}

_attempt_stage_state_publish_event_locked() {
  local event_tmp=$1 sequence hash final
  chmod 400 "$event_tmp" || return 1
  sync -f "$event_tmp" 2>/dev/null || true
  sequence=$(_attempt_stage_state_json event-sequence "$event_tmp") || return
  hash=$(sha256sum -- "$event_tmp" | awk '{print $1}') || return 1
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]] || return 78
  printf -v final '%s/event.%020d.%s.json' "$ASTAGE_RESULTS_DIR" "$sequence" "$hash"
  [[ ! -e "$final" && ! -L "$final" ]] || return 78
  mv -- "$event_tmp" "$final" || return 1
  ASTAGE_EVENT_FILE=$final
  ASTAGE_EVENT_HASH=$hash
}

_attempt_stage_state_publish_runtime_locked() {
  local runtime_payload=$1 tmp rc
  tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.runtime.XXXXXX") || return 1
  _attempt_stage_state_json make-envelope "$runtime_payload" >"$tmp"
  rc=$?
  if (( rc != 0 )); then
    rm -f -- "$tmp"
    return "$rc"
  fi
  chmod 400 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$ASTAGE_RESULTS_DIR/runtime.json" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$ASTAGE_RESULTS_DIR/runtime.json" 2>/dev/null || true
}

_attempt_stage_state_append_locked() {
  local event_tmp=$1 runtime_tmp rc
  _attempt_stage_state_publish_event_locked "$event_tmp" || return
  runtime_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.runtime-payload.XXXXXX") || return 1
  _attempt_stage_state_json runtime-from-event \
    "$ASTAGE_EVENT_FILE" "$ASTAGE_EVENT_HASH" "$ASTAGE_ENTRY" >"$runtime_tmp"
  rc=$?
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_publish_runtime_locked "$runtime_tmp"
    rc=$?
  fi
  rm -f -- "$runtime_tmp"
  return "$rc"
}

attempt_stage_state_init_v2() {
  local task attempt route root lock_fd event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  route=$(_attempt_state_route_id "${3:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" "$route"
  rc=$?
  if (( rc == 0 )) && [[ -e "$ASTAGE_RESULTS_DIR/runtime.json" ||
                         -L "$ASTAGE_RESULTS_DIR/runtime.json" ]]; then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
    _attempt_state_unlock "$lock_fd"
    return "$rc"
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json assert-empty "$ASTAGE_RESULTS_DIR" || rc=$?
  fi
  if (( rc == 0 )); then
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json make-init \
      "$task" "$attempt" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" \
      "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" "$ASTAGE_ENTRY" "$now" >"$event_tmp" ||
      rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_read_v2() {
  local task attempt root lock_fd rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Возвращает последний event только после полной проверки immutable hash-chain и
# runtime pointer. Проекции интерфейса используют его как канонический источник
# reset-списка; брать действие повторно из mutable `.pipeline` запрещено.
attempt_stage_state_latest_event_v2() {
  local task attempt root lock_fd runtime_tmp sequence hash event rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    sequence=$(_attempt_state_json get "$runtime_tmp" sequence) || rc=$?
    hash=$(_attempt_state_json get "$runtime_tmp" headEventHash) || rc=$?
  fi
  if (( rc == 0 )); then
    [[ "$sequence" =~ ^(0|[1-9][0-9]*)$ && "$hash" =~ ^[a-f0-9]{64}$ ]] || rc=78
  fi
  if (( rc == 0 )); then
    printf -v event '%s/event.%020d.%s.json' "$ASTAGE_RESULTS_DIR" "$sequence" "$hash"
    [[ -f "$event" && ! -L "$event" ]] || rc=78
  fi
  if (( rc == 0 )); then
    cat -- "$event"
    rc=$?
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Человеческий возврат курсора на пройденный узел маршрута. Это НЕ подделка
# исхода агента: в журнал ложится отдельное событие kind=human-rewind с
# обязательной причиной, а пройденные узлы сбрасываются, как при обычном rewind.
# Появился из кнопки «перейти сюда» кокпита: у v1 она форсировала статус этапа
# напрямую в реестре, в v2 такой путь закрыт — нужен доверенный эквивалент.
attempt_stage_state_human_rewind_v2() {
  local task attempt node reset reason root lock_fd runtime_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  reset=${4:-}
  reason=${5:-}
  [[ -n "$reset" ]] || return 2
  _attempt_state_reason "$reason" || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-human-rewind \
      "$runtime_tmp" "$ASTAGE_RESULTS_DIR" "$node" "$reset" "$reason" "$now" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Указание человека, приложенное к возврату курсора на узел, — для промпта захода.
# Чтение, ничего не пишет. Пустой вывод — норма: в узел вошли обычным ходом маршрута,
# а не возвратом, либо узел с тех пор уже закрывали коммитом.
attempt_stage_state_human_note_v2() {
  local task attempt node lock_fd rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    _attempt_stage_state_json human-note "$ASTAGE_RESULTS_DIR" "$node"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Производная проекция immutable events: какие typed findings ещё открыты и какие
# уже закрыты повторной проверкой того же узла. Ничего отдельно не мутируется — при
# повреждении hash-chain чтение падает до построения проекции.
attempt_stage_state_findings_v2() {
  local task attempt lock_fd runtime_tmp rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-findings.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json findings-ledger "$ASTAGE_RESULTS_DIR"
    rc=$?
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Производная проекция immutable events: отработанное время по узлам в секундах
# плюс метка последнего события (JSON: nodes, lastEventAt). Чтение, ничего не
# пишет; при повреждении hash-chain падает до построения проекции.
attempt_stage_state_work_time_v2() {
  local task attempt lock_fd runtime_tmp rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-work-time.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json work-time "$ASTAGE_RESULTS_DIR"
    rc=$?
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_pause_v2() {
  local task attempt node reason root lock_fd runtime_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  reason=${4:-}
  _attempt_state_reason "$reason" || return
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-pause \
      "$runtime_tmp" "$node" "$reason" "$now" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

attempt_stage_state_commit_v2() {
  local task attempt node outcome rewind_limit verdict_b64 no_progress_limit recovery
  local target_budget reject_feedback failure_owner root lock_fd
  local runtime_tmp transition_tmp event_tmp now rc
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  node=$(_attempt_stage_state_node_id "${3:-}") || return
  outcome=$(_attempt_stage_state_outcome "${4:-}") || return
  rewind_limit=${5:-0}
  verdict_b64=${6:-}
  no_progress_limit=${7:-0}
  # Восьмой аргумент — «узел закрыт восстановлением, а не заходом»: единственный
  # коммит, который не снимает указание человека с узла.
  recovery=${8:-0}
  # Девятый — суммарный бюджет автоматических возвратов в target за попытку:
  # последний предохранитель после no-progress и лимита дуги, решением человека
  # не обнуляется.
  target_budget=${9:-0}
  # Десятый — замечание человека у rejected-ворот. Оно ложится в immutable reason
  # коммита и адресуется узлу rewind через общий канал human note.
  reject_feedback=${10:-}
  [[ "$rewind_limit" =~ ^(0|[1-9]|10)$ ]] || return 2
  [[ "$no_progress_limit" =~ ^(0|[1-9]|10)$ ]] || return 2
  [[ "$target_budget" =~ ^(0|[1-9]|10)$ ]] || return 2
  [[ "$recovery" == 0 || "$recovery" == 1 ]] || return 2
  [[ -z "$reject_feedback" ]] || _attempt_state_reason "$reject_feedback" || return
  run_state_verdict_validate "$outcome" "$verdict_b64" || return
  # Владелец выбирает ВЕТКУ ВОЗВРАТА, поэтому нужен только отказу. У приёмки с
  # отложенным хвостом вердикт есть, а возврата нет: переход берётся по одному
  # исходу, и owner в запрос перехода не идёт (factory-route его там запрещает).
  failure_owner=""
  if [[ "$outcome" == failed ]]; then
    failure_owner=$(run_state_verdict_owner "$outcome" "$verdict_b64") || return
  fi
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" ""
  rc=$?
  if (( rc == 0 )); then
    runtime_tmp=$(mktemp "$ASTAGE_ATTEMPT_DIR/.runtime-read.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_validate_internal_locked "$task" "$attempt" >"$runtime_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    chmod 400 "$runtime_tmp" || rc=1
    transition_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.transition.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    local -a transition_args=(
      "$(_attempt_state_route_tool)"
      --routes-dir "$ASTAGE_ROUTES_DIR"
      --profile "$ASTAGE_PROFILE"
      transition
      --catalog-hash "$ASTAGE_CATALOG_HASH"
      --route "$ASTAGE_ROUTE"
      --node "$node"
      --outcome "$outcome"
    )
    [[ -z "$failure_owner" ]] || transition_args+=(--failure-owner "$failure_owner")
    "${transition_args[@]}" >"$transition_tmp"
    rc=$?
  fi
  if (( rc == 0 )); then
    now=$(_attempt_stage_state_now) || rc=$?
    event_tmp=$(mktemp "$ASTAGE_RESULTS_DIR/.event.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_json prepare-commit \
      "$runtime_tmp" "$transition_tmp" "$ASTAGE_RESULTS_DIR" "$node" "$outcome" \
      "$now" "$rewind_limit" "$verdict_b64" "$no_progress_limit" "$recovery" \
      "$target_budget" "$reject_feedback" >"$event_tmp"
    rc=$?
    if (( rc == 10 )); then
      rm -f -- "$event_tmp" "$transition_tmp" "$runtime_tmp"
      _attempt_stage_state_validate_locked "$task" "$attempt"
      rc=$?
      _attempt_state_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_append_locked "$event_tmp"
    rc=$?
  else
    [[ -z "${event_tmp:-}" ]] || rm -f -- "$event_tmp"
  fi
  [[ -z "${transition_tmp:-}" ]] || rm -f -- "$transition_tmp"
  [[ -z "${runtime_tmp:-}" ]] || rm -f -- "$runtime_tmp"
  if (( rc == 0 )); then
    _attempt_stage_state_validate_locked "$task" "$attempt"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}
