#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_claude_probe() {
  local version
  command -v claude >/dev/null 2>&1 || return 4
  version=$(factory_exec provider claude --version) || return
  # Empty --setting-sources is an audited fail-closed contract of this exact
  # native CLI. A future release stays unavailable until its parsing and sandbox
  # schema have been reviewed instead of silently re-enabling disk settings.
  [[ "$version" =~ ^2\.1\.220([[:space:]]|$) ]] || return 4
  printf '%s\n' "$version"
}

runner_claude_catalog() {
  # Claude CLI пока не отдаёт стабильный machine-readable model catalog.
  # Discovery adapter должен заменить эту заглушку live/cache/probed-seed snapshot.
  return 4
}

runner_claude_default_policy() {
  printf 'FAMILY=opus\nVERSION=latest\nVARIANT=auto\nEFFORT=max\n'
}

runner_claude_family_alias() {
  # Каталога нет (см. runner_claude_catalog), поэтому семейство уходит прямо в `--model`:
  # список обязан совпадать с алиасами установленного CLI. Fable добавлен по 2.1.220,
  # где `--model fable` резолвится самим CLI наравне с opus и sonnet.
  case "${1:-}" in opus|fable|sonnet|haiku) return 0 ;; *) return 4 ;; esac
}

runner_claude_capabilities() {
  # status_request обязателен: текущий Claude CLI не наследует fd 7 в тул-шелл;
  # fd-транспорт остаётся быстрым путём там,
  # где он ещё жив, — stage-result сам выбирает доступный.
  # `sandbox` в списке нет намеренно: native OS sandbox временно снят (см. lib/core.sh),
  # и заявлять границу, которой нет, опаснее, чем её отсутствие.
  printf 'status status_fd status_request tools structured_output fanout\n'
}

_runner_claude_trusted_settings() {
  local control=${RUNNER_CLAUDE_CONTROL_DIR:-} settings=${RUNNER_CLAUDE_SETTINGS:-}
  command -v python3 >/dev/null 2>&1 || return 78
  python3 - "$control" "$settings" <<'PYTHON'
import json
import os
import stat
import sys

control, settings = sys.argv[1:]


def fail():
    raise SystemExit(78)


if not os.path.isabs(control) or not os.path.isabs(settings):
    fail()
control = os.path.normpath(control)
settings = os.path.normpath(settings)
if control == os.sep or os.path.realpath(control) != control:
    fail()
try:
    control_stat = os.lstat(control)
except OSError:
    fail()
if (not stat.S_ISDIR(control_stat.st_mode) or stat.S_ISLNK(control_stat.st_mode)
        or control_stat.st_uid != os.getuid()
        or stat.S_IMODE(control_stat.st_mode) != 0o700):
    fail()
try:
    if os.path.commonpath((control, settings)) != control or settings == control:
        fail()
except ValueError:
    fail()
try:
    settings_stat = os.lstat(settings)
except OSError:
    fail()
if (not stat.S_ISREG(settings_stat.st_mode) or stat.S_ISLNK(settings_stat.st_mode)
        or settings_stat.st_uid != os.getuid() or settings_stat.st_nlink != 1
        or stat.S_IMODE(settings_stat.st_mode) != 0o400
        or settings_stat.st_size > 2 * 1024 * 1024
        or os.path.realpath(settings) != settings):
    fail()
try:
    with open(settings, encoding="utf-8") as source:
        value = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError):
    fail()

permissions = value.get("permissions") if isinstance(value, dict) else None
if not isinstance(permissions, dict):
    fail()

# Native OS sandbox снят с обязательных требований: на Linux это bwrap-namespace, который
# отбирает у агента группу docker и хостовый localhost, то есть весь канал до стенда
# (см. lib/core.sh и ../docs/engine/ENGINE.md). Но если блок всё же объявлен — он обязан быть
# ровно той аудированной формой, что была: полумеры вроде excludedCommands или allowRead
# опаснее честного отсутствия границы, потому что выглядят как граница.
sandbox = value.get("sandbox")
if sandbox is not None:
    filesystem = sandbox.get("filesystem") if isinstance(sandbox, dict) else None
    if (not isinstance(sandbox, dict) or sandbox.get("enabled") is not True
            or sandbox.get("failIfUnavailable") is not True
            or sandbox.get("allowUnsandboxedCommands") is not False
            or "excludedCommands" in sandbox or not isinstance(filesystem, dict)
            or "allowRead" in filesystem):
        fail()
    for key in ("denyRead", "denyWrite"):
        rules = filesystem.get(key)
        if not isinstance(rules, list) or control not in rules or f"{control}/**" not in rules:
            fail()

deny = permissions.get("deny")
if not isinstance(deny, list) or not all(isinstance(rule, str) for rule in deny):
    fail()
tool_control = f"//{control.lstrip('/')}"
required = {
    f"{tool}({path})"
    for tool in ("Read", "Edit", "Write", "NotebookEdit")
    for path in (tool_control, f"{tool_control}/**")
}
if not required.issubset(deny):
    fail()
PYTHON
}

runner_claude_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  _runner_claude_trusted_settings || return
  local -a args=(
    claude -p "$prompt" --output-format stream-json --verbose
    --settings "$RUNNER_CLAUDE_SETTINGS"
    --setting-sources ""
    --strict-mcp-config
    --disable-slash-commands
  )
  # --safe-mode сознательно снят: конвейерным агентам нужна память проекта
  # (CLAUDE.md с @-импортами знаний) из cwd-ворктри. Границу держат оставшиеся
  # флаги: с пустым --setting-sources hooks/плагины/проектным агентам неоткуда
  # загрузиться, --strict-mcp-config без --mcp-config не поднимает MCP,
  # --disable-slash-commands глушит skills.
  [[ -z "$model" ]] || args+=(--model "$model")
  [[ -z "$effort" ]] || args+=(--effort "$effort")
  local add_dir
  for add_dir in ${RUNNER_CLAUDE_ADD_DIRS:-}; do
    [[ -d "$add_dir" ]] && args+=(--add-dir "$add_dir")
  done
  args+=(--permission-mode acceptEdits)
  # Порог автосжатия — диалект этого CLI. Движок отдаёт нейтральный
  # RUNNER_AUTO_COMPACT_WINDOW, перевод в переменную окружения принадлежит раннеру.
  # `0`/пусто — не вмешиваться: у CLI остаётся собственный порог от окна модели.
  if [[ "${RUNNER_AUTO_COMPACT_WINDOW:-0}" =~ ^[1-9][0-9]*$ ]]; then
    export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$RUNNER_AUTO_COMPACT_WINDOW"
  else
    unset CLAUDE_CODE_AUTO_COMPACT_WINDOW
  fi
  # -k: голый timeout шлёт только TERM и уходит. Провайдер, застрявший в необрываемом
  # вызове, пережил бы его и остался висеть с занятым слотом; KILL через 30 с закрывает
  # эту дыру. Код возврата остаётся 124 (GNU timeout не меняет его из-за KILL), поэтому
  # классификация timeout в runner_claude_classify работает как прежде.
  factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
}

_runner_fixture_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_claude_no_model_activity() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

try:
    source = open(sys.argv[1], encoding="utf-8", errors="replace")
except OSError:
    raise SystemExit(1)

for line in source:
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        # Повреждённый stream не доказывает, что до 401/403 ничего не случилось.
        raise SystemExit(1)
    if event.get("type") == "assistant":
        message = event.get("message") or {}
        model = message.get("model")
        content = message.get("content") or []
        if model and model != "<synthetic>":
            raise SystemExit(1)
        if any(isinstance(block, dict) and block.get("type") == "tool_use"
               for block in content):
            raise SystemExit(1)
    if event.get("type") == "user":
        content = (event.get("message") or {}).get("content") or []
        if any(isinstance(block, dict) and block.get("type") == "tool_result"
               for block in content):
            raise SystemExit(1)
raise SystemExit(0)
PYTHON
}

runner_claude_classify() {
  local run_dir=$1 rc=$2 version verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(_runner_fixture_meta "$run_dir" CLI_VERSION)
  verified=$(_runner_fixture_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_fixture_meta "$run_dir" SOURCE)
  [[ "$version" =~ ^(1|2)\. ]] || { printf 'unknown\n'; return; }
  if grep -qiE 'sandbox denied|permission denied' "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'denied\n'
    return
  fi
  # Любая новая сигнатура допускается только из runtime или проверенной fixture.
  # Непроверенный текст «usage limit» остаётся unknown и никогда не меняет ИИ.
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*413' -e 'status["=: ]+413' \
      -e 'request too large' -e 'context[_ -]length[_ -]exceeded' \
      -e 'context window.*exceed' -e 'prompt is too long' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'context_overflow\n'
    return
  fi
  # Отказ по лимиту подписки CLI объявляет машинным событием `rate_limit_event`
  # со `status: rejected` — и это единственный прицельный признак: у пятичасового
  # окна текст другой («You've hit your session limit · resets 9:30pm»), а
  # словесные шаблоны ниже совпадали на нём случайно, за счёт соседнего блока
  # `"usage":{…}` в той же строке результата. Тип окна (`five_hour`/`seven_day`)
  # значения не имеет: отказ есть отказ, срок разбирает `limit_until`.
  if grep -qiE \
      -e '"type":"subscription_limit_reached"' \
      -e '"type":"rate_limit_event".*"status":"rejected"' \
      -e "hit your (session|weekly|monthly|usage) limit" \
      -e '429.*(weekly|subscription|usage).*(limit|reached)' \
      -e '(weekly|subscription|usage).*limit.*(reached|reset)' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*429' -e 'status["=: ]+429' \
      -e '"type":"rate_limit_error"' -e 'too many requests' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'transient\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*(401|403)' \
      -e 'status["=: ]+(401|403)' -e 'invalid authentication credentials' \
      -e 'authentication.*(expired|required)' -e 'request not allowed' \
      -e 'run claude login' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_claude_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
  fi
  printf 'unknown\n'
}

runner_claude_limit_until() {
  # Опциональный метод контракта: до какого времени провайдер отказывает.
  # Claude называет срок машинным полем `resetsAt` (unix) внутри
  # `rate_limit_event`; берём ПОСЛЕДНЕЕ событие со `status: rejected` — ранние
  # `allowed_warning` того же окна описывают ещё разрешённые запросы.
  local run_dir=$1 value
  value=$(grep -o '"rate_limit_info":{[^}]*}' "$run_dir/events.jsonl" 2>/dev/null |
    grep '"status":"rejected"' |
    grep -o '"resetsAt":[0-9]\+' |
    tail -1)
  value=${value##*:}
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

runner_claude_fanout_count() {
  grep -cE '"name":"(Agent|Task)"' "$1/events.jsonl" 2>/dev/null || printf '0\n'
}

runner_claude_dialect() {
  printf 'Claude stream-json; terminal status only through stage-result.\n'
}

runner_claude_interrupt() {
  return 0
}
