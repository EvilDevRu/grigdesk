#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/pipeline-store.sh"

factory_control_root() {
  local candidate state normalized normalized_state
  if [[ -n "${FACTORY_CONTROL_ROOT:-}" ]]; then
    candidate=$FACTORY_CONTROL_ROOT
  elif [[ -n "${FACTORY_CONFIG_ROOT:-}" ]]; then
    candidate="$FACTORY_CONFIG_ROOT/control"
  else
    candidate="${HOME:?HOME or FACTORY_CONFIG_ROOT is required}/.factory/control"
  fi
  [[ "$candidate" == /* && "$candidate" != *$'\n'* && "$candidate" != *$'\t'* ]] ||
    return 78
  normalized=$(realpath -m -- "$candidate" 2>/dev/null) || return 78
  [[ "$normalized" == "$candidate" && "$normalized" != / ]] || return 78

  # Provider получает STATE_DIR как writable add-dir. Control metadata обязана
  # находиться в непересекающемся дереве, иначе agent сможет подменить CAS/guard.
  state=${STATE_DIR:-${FACTORY_STATE:-}}
  if [[ -n "$state" ]]; then
    normalized_state=$(realpath -m -- "$state" 2>/dev/null) || return 78
    case "$normalized" in
      "$normalized_state"|"$normalized_state"/*) return 78 ;;
    esac
    case "$normalized_state" in
      "$normalized"|"$normalized"/*) return 78 ;;
    esac
  fi
  printf '%s\n' "$normalized"
}

factory_token_hash() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

factory_control_init() {
  local token=${1:?control token} root tmp
  root=$(factory_control_root) || return
  mkdir -p "$root"
  [[ ! -L "$root" && "$(realpath -e -- "$root" 2>/dev/null)" == "$root" ]] || return 78
  chmod 700 "$root" 2>/dev/null || true
  tmp=$(mktemp "$root/.control.XXXXXX")
  factory_token_hash "$token" >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$root/control.hash"
}

factory_control_verify() {
  local token=${1:-} root expected
  root=$(factory_control_root)
  expected=$(head -1 "$root/control.hash" 2>/dev/null | tr -d '[:space:]')
  [[ -n "$token" && -n "$expected" && "$(factory_token_hash "$token")" == "$expected" ]]
}

run_state_active_file() {
  local task=${1#[tT]} stage=${2:?stage} root
  [[ "$stage" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
  root=$(factory_control_root)
  printf '%s/runs/t%s/%s.active\n' "$root" "$task" "$stage"
}

_run_state_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

# Типизированный verdict остаётся частью run-scoped status protocol, а не свободным
# полем реестра. Агент передаёт только allowlisted owner и стабильные finding id;
# здесь payload канонизируется до того, как попадёт в trusted control record.
_run_state_verdict() {
  python3 - "$@" <<'PY'
import base64
import json
import re
import sys

operation, result, encoded, *findings_raw = sys.argv[1:]
owners = {"build", "tests", "environment", "plan", "human"}
finding_re = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SUMMARY_LIMIT = 500
FINDINGS_LIMIT = 32
PATH_LIMIT = 200
REVIEWED_LIMIT = 64
# Метаданные вердикта едут тем же списком, что и замечания: у finding-id формат
# kebab-case, двоеточия в нём нет, поэтому префикс однозначно отделяет их от
# `id=summary` и не ломает уже написанные вызовы с одними замечаниями.
ANCHOR_PREFIX = "anchor:"
REVIEWED_PREFIX = "reviewed:"
DEFERRED_PREFIX = "deferred:"
# Вес замечания. `blocking` — дефолт и единственное, что возвращает работу автору;
# `deferred` — та самая находка «outside scope / follow-up», которую общий шаблон
# этапа давно разрешает словами, но выразить машинно было нечем: любой список
# findings ехал только с `failed`, а `failed` всегда означал возврат. Из-за этого
# проверяющий, увидев дефект вне цели задачи, был обязан либо развернуть маршрут,
# либо промолчать. Отсутствие поля читается как `blocking` — старые события в
# immutable ledger остаются валидными без миграции.
SEVERITIES = {"blocking", "deferred"}
DEFAULT_SEVERITY = "blocking"


# Отказ обязан называть нарушенное правило. Молчащий код 2 стоил вердикта этапа: на t7802
# скептик 17 минут не мог отчитаться (summary длиннее лимита), угадывал причину пробными
# вызовами — и терминальный исход узла закрыл диагностический плейсхолдер, потому что
# повторная фиксация того же run уже отклоняется. Печатаем правило и id, но не текст
# замечания: то же сообщение уходит в журнал маршрута при trusted-проверке.
def fail(reason="вердикт отклонён"):
    print(f"stage-result: {reason}", file=sys.stderr)
    raise SystemExit(2)


def artifact_path(value):
    # Якорь замечания и объявленный охват — относительные пути рабочего дерева.
    return (
        isinstance(value, str)
        and 1 <= len(value) <= PATH_LIMIT
        and not value.startswith("/")
        and ".." not in value.split("/")
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def validate(value):
    if not isinstance(value, dict) or not {"owner", "findings"} <= set(value) or not set(
        value
    ) <= {"owner", "findings", "reviewed"}:
        fail("вердикт состоит из owner, findings и необязательного reviewed")
    owner = value.get("owner")
    findings = value.get("findings")
    if owner not in owners:
        fail(f"неизвестный failure-owner; допустимы: {', '.join(sorted(owners))}")
    if not isinstance(findings, list) or not 1 <= len(findings) <= FINDINGS_LIMIT:
        count = len(findings) if isinstance(findings, list) else "нет списка"
        fail(f"замечаний {count}, допустимо 1..{FINDINGS_LIMIT}")
    seen = set()
    for index, finding in enumerate(findings, start=1):
        if not isinstance(finding, dict) or not {"id", "summary"} <= set(
            finding
        ) or not set(finding) <= {"id", "summary", "anchor", "severity"}:
            fail(
                f"замечание {index}: поля id и summary, "
                "необязательно anchor и severity"
            )
        finding_id = finding.get("id")
        summary = finding.get("summary")
        if not isinstance(finding_id, str) or not finding_re.fullmatch(finding_id):
            fail(
                f"замечание {index}: id должен быть kebab-case до 64 символов "
                "(^[a-z0-9][a-z0-9-]{0,63}$)"
            )
        if finding_id in seen:
            fail(f"замечание {index} (id={finding_id}): такой id уже был в этом вердикте")
        if not isinstance(summary, str) or not 1 <= len(summary) <= SUMMARY_LIMIT:
            length = len(summary) if isinstance(summary, str) else "нет строки"
            fail(
                f"замечание {index} (id={finding_id}): summary {length} символов, "
                f"допустимо 1..{SUMMARY_LIMIT}; развёрнутый разбор кладётся в файл этапа"
            )
        if any(ord(char) < 32 or ord(char) == 127 for char in summary):
            fail(
                f"замечание {index} (id={finding_id}): summary — одна строка, "
                "переводы строки и управляющие символы запрещены"
            )
        if "anchor" in finding and not artifact_path(finding["anchor"]):
            fail(
                f"замечание {index} (id={finding_id}): anchor — относительный путь "
                f"файла до {PATH_LIMIT} символов, без ведущего / и без .."
            )
        if "severity" in finding and finding["severity"] not in SEVERITIES:
            fail(
                f"замечание {index} (id={finding_id}): severity — "
                f"{' или '.join(sorted(SEVERITIES))}"
            )
        seen.add(finding_id)
    reviewed = value.get("reviewed")
    if reviewed is not None:
        if not isinstance(reviewed, list) or not 1 <= len(reviewed) <= REVIEWED_LIMIT:
            count = len(reviewed) if isinstance(reviewed, list) else "нет списка"
            fail(f"reviewed: путей {count}, допустимо 1..{REVIEWED_LIMIT}")
        if len(set(reviewed)) != len(reviewed):
            fail("reviewed: пути не должны повторяться")
        for path in reviewed:
            if not artifact_path(path):
                fail(
                    "reviewed: каждый путь — относительный, до "
                    f"{PATH_LIMIT} символов, без ведущего / и без .."
                )
    return value


if operation == "encode":
    owner = encoded
    # `done` несёт вердикт только ради отложенных находок: проверяющий принял работу,
    # но нашёл дефект вне цели задачи. Прежде такую находку деть было некуда — список
    # findings движок принимал исключительно с `failed`, то есть ценой возврата в сборку.
    if result not in {"failed", "done"}:
        if owner or findings_raw:
            fail(
                f"результат {result}: --failure-owner и --finding "
                "допустимы только у failed и done"
            )
        print("")
        raise SystemExit(0)
    if not owner and not findings_raw:
        # Старые prompts продолжают законно посылать обычный failed без metadata.
        print("")
        raise SystemExit(0)
    if result == "done" and not findings_raw:
        fail("результат done: --failure-owner без замечаний не имеет смысла")
    parsed = []
    anchors = {}
    reviewed = []
    for index, raw in enumerate(findings_raw, start=1):
        if raw.startswith(REVIEWED_PREFIX):
            reviewed.append(raw[len(REVIEWED_PREFIX):])
            continue
        if raw.startswith(ANCHOR_PREFIX):
            body = raw[len(ANCHOR_PREFIX):]
            if "=" not in body:
                fail("--finding-anchor: ожидается вид id=путь")
            anchor_id, anchor_path_value = body.split("=", 1)
            if anchor_id in anchors:
                fail(f"--finding-anchor: якорь для id={anchor_id} задан дважды")
            anchors[anchor_id] = anchor_path_value
            continue
        severity = DEFAULT_SEVERITY
        if raw.startswith(DEFERRED_PREFIX):
            severity = "deferred"
            raw = raw[len(DEFERRED_PREFIX):]
        if "=" not in raw:
            fail(f"--finding {index}: ожидается вид id=краткое замечание")
        finding_id, summary = raw.split("=", 1)
        finding = {"id": finding_id, "summary": summary}
        # Дефолтный вес в payload не пишем: канонический JSON вердикта без отложенных
        # находок остаётся байт-в-байт прежним, а с ним и хеш события в ledger.
        if severity != DEFAULT_SEVERITY:
            finding["severity"] = severity
        parsed.append(finding)
    for finding in parsed:
        if finding["id"] in anchors:
            finding["anchor"] = anchors.pop(finding["id"])
    if anchors:
        fail(
            "--finding-anchor ссылается на id, которых нет в вердикте: "
            + ", ".join(sorted(anchors))
        )
    blocking = [
        finding["id"]
        for finding in parsed
        if finding.get("severity", DEFAULT_SEVERITY) == "blocking"
    ]
    if result == "done" and blocking:
        fail(
            "результат done: блокирующие замечания недопустимы — "
            "объяви их отложенными или верни failed: " + ", ".join(sorted(blocking))
        )
    if result == "done" and not owner:
        # У отложенной находки владелец нужен воротам, чтобы показать человеку, к кому
        # она пойдёт follow-up'ом. Отдельного флага у агента для этого не просим.
        owner = "build"
    value = {"owner": owner, "findings": parsed}
    if reviewed:
        value["reviewed"] = reviewed
    value = validate(value)
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    print(base64.b64encode(payload).decode("ascii"))
elif operation in {"validate", "owner"}:
    if not encoded:
        if operation == "owner":
            print("")
        raise SystemExit(0)
    if result not in {"failed", "done"} or not re.fullmatch(
        r"[A-Za-z0-9+/]+={0,2}", encoded
    ):
        fail(f"результат {result}: typed verdict возможен только у failed и done")
    try:
        payload = base64.b64decode(encoded, validate=True)
        if len(payload) > 32 * 1024:
            fail("payload вердикта больше 32 КиБ")
        value = json.loads(
            payload.decode("utf-8"),
            parse_constant=lambda _: fail("вердикт содержит NaN/Infinity"),
        )
    except (ValueError, UnicodeError, json.JSONDecodeError):
        fail("вердикт не является валидным base64 с JSON внутри")
    value = validate(value)
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if canonical != payload:
        fail("вердикт записан не в канонической форме")
    if result == "done" and any(
        finding.get("severity", DEFAULT_SEVERITY) == "blocking"
        for finding in value["findings"]
    ):
        fail("результат done: вердикт содержит блокирующие замечания")
    if operation == "owner":
        print(value["owner"])
else:
    fail(f"неизвестная операция {operation}")
PY
}

run_state_verdict_encode() {
  local result=$1 owner=${2:-}
  shift 2
  _run_state_verdict encode "$result" "$owner" "$@"
}

run_state_verdict_validate() {
  _run_state_verdict validate "$1" "${2:-}"
}

run_state_verdict_owner() {
  _run_state_verdict owner "$1" "${2:-}"
}

_run_state_write() {
  local file=$1 run_id=$2 epoch=$3 token_hash=$4 state=$5 result=${6:-} comment=${7:-}
  local verdict_b64=${8:-}
  local tmp
  mkdir -p "$(dirname "$file")"
  tmp=$(mktemp "$(dirname "$file")/.active.XXXXXX")
  {
    printf 'SCHEMA=1\nRUN_ID=%s\nEPOCH=%s\nTOKEN_HASH=%s\nSTATE=%s\n' \
      "$run_id" "$epoch" "$token_hash" "$state"
    [[ -z "$result" ]] || printf 'RESULT=%s\n' "$result"
    [[ -z "$comment" ]] || printf 'COMMENT=%s\n' "${comment//$'\n'/ }"
    [[ -z "$verdict_b64" ]] || printf 'VERDICT_B64=%s\n' "$verdict_b64"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$file"
}

run_state_begin() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5
  [[ "$run_id" =~ ^[A-Za-z0-9._-]+$ && "$epoch" =~ ^[0-9]+$ ]] || return 2
  local lock_fd file token_hash rc current_epoch
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  if [[ -f "$file" ]]; then
    current_epoch=$(_run_state_get "$file" EPOCH)
    if [[ "$current_epoch" =~ ^[0-9]+$ ]] && (( epoch <= current_epoch )); then
      pipeline_lock_release "$lock_fd"
      return 73
    fi
  fi
  token_hash=$(factory_token_hash "$token")
  _run_state_write "$file" "$run_id" "$epoch" "$token_hash" active
  pipeline_store_update_unlocked "$task" RUN_PROTOCOL 2 "$stage" running \
    "ACTIVE_RUN_${stage}" "$run_id" "ACTIVE_EPOCH_${stage}" "$epoch"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_apply_result() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5 result=$6 comment=${7:-}
  local verdict_b64=${8:-}
  case "$result" in done|skipped|failed) ;; *) return 2 ;; esac
  run_state_verdict_validate "$result" "$verdict_b64" || return
  local lock_fd file active_run active_epoch expected_hash state stored_result stored_comment rc
  local stored_verdict
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  if [[ ! -f "$file" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  active_run=$(_run_state_get "$file" RUN_ID)
  active_epoch=$(_run_state_get "$file" EPOCH)
  expected_hash=$(_run_state_get "$file" TOKEN_HASH)
  state=$(_run_state_get "$file" STATE)
  if [[ "$active_run" != "$run_id" || "$active_epoch" != "$epoch" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ -z "$token" || "$(factory_token_hash "$token")" != "$expected_hash" ]]; then
    pipeline_lock_release "$lock_fd"
    return 74
  fi
  if [[ "$state" == committed ]]; then
    stored_result=$(_run_state_get "$file" RESULT)
    stored_comment=$(_run_state_get "$file" COMMENT)
    stored_verdict=$(_run_state_get "$file" VERDICT_B64)
    run_state_verdict_validate "$stored_result" "$stored_verdict" || {
      pipeline_lock_release "$lock_fd"
      return 78
    }
    pipeline_store_update_unlocked "$task" "$stage" "$stored_result" \
      "${stage}_COMMENT" "$stored_comment" "ACTIVE_RUN_${stage}" ""
    pipeline_lock_release "$lock_fd"
    return 75
  fi
  [[ "$state" == active ]] || {
    pipeline_lock_release "$lock_fd"
    return 75
  }
  _run_state_write "$file" "$run_id" "$epoch" "$expected_hash" committed \
    "$result" "$comment" "$verdict_b64"
  pipeline_store_update_unlocked "$task" "$stage" "$result" "${stage}_COMMENT" "$comment" \
    "ACTIVE_RUN_${stage}" ""
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_validate_progress() {
  local stage=$1; shift
  (( $# >= 2 && $# % 2 == 0 )) || return 2
  local key value
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$key" != "$stage" ]] || return 2
    case "$key" in
      SIZE)
        [[ "$value" =~ ^(S|M|L)$ ]] || return 2 ;;
      PLANS|SKEPTIC|VALIDATE|TRANSLATOR)
        [[ "$value" =~ ^(running|done|skipped)$ ]] || return 2 ;;
      *)
        return 2 ;;
    esac
  done
}

run_state_apply_progress() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5; shift 5
  run_state_validate_progress "$stage" "$@" || return
  local -a updates=("$@")

  local lock_fd file active_run active_epoch expected_hash state rc
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  [[ -f "$file" ]] || {
    pipeline_lock_release "$lock_fd"
    return 73
  }
  active_run=$(_run_state_get "$file" RUN_ID)
  active_epoch=$(_run_state_get "$file" EPOCH)
  expected_hash=$(_run_state_get "$file" TOKEN_HASH)
  state=$(_run_state_get "$file" STATE)
  if [[ "$active_run" != "$run_id" || "$active_epoch" != "$epoch" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ -z "$token" || "$(factory_token_hash "$token")" != "$expected_hash" ]]; then
    pipeline_lock_release "$lock_fd"
    return 74
  fi
  [[ "$state" == active ]] || {
    pipeline_lock_release "$lock_fd"
    return 75
  }
  pipeline_store_update_unlocked "$task" "${updates[@]}"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_control_update() {
  local task=$1; shift
  (( $# >= 2 && $# % 2 == 0 )) || return 2
  local stage=$1 result=$2 key value comment="" file=""
  local lock_fd run_id epoch token_hash rc
  case "$result" in
    done|skipped|failed)
      local -a pairs=("$@")
      local i
      for (( i=0; i<${#pairs[@]}; i+=2 )); do
        if [[ "${pairs[$i]}" == "${stage}_COMMENT" ]]; then
          comment=${pairs[$((i+1))]}
        fi
      done
      ;;
    *) stage="" ;;
  esac
  pipeline_lock_acquire "$task" lock_fd || return
  if [[ -n "$stage" ]]; then
    file=$(run_state_active_file "$task" "$stage" 2>/dev/null || true)
    if [[ -n "$file" && -f "$file" ]]; then
      run_id=$(_run_state_get "$file" RUN_ID)
      epoch=$(_run_state_get "$file" EPOCH)
      token_hash=$(_run_state_get "$file" TOKEN_HASH)
      _run_state_write "$file" "$run_id" "$epoch" "$token_hash" committed "$result" "$comment"
    fi
  fi
  pipeline_store_update_unlocked "$task" "$@"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}
