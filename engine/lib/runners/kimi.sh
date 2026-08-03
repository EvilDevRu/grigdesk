#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_kimi_probe() {
  local version
  command -v kimi >/dev/null 2>&1 || return 4
  version=$(factory_exec provider kimi --version) || return
  # Fail-closed пин 0.31.1 (KIMI.md): `kimi upgrade` кладёт kimi.bak и молча ломает
  # пин, поэтому другая версия остаётся недоступной, пока сигнатуры classify не
  # пересмотрены под новый CLI.
  [[ "$version" =~ (^|[[:space:]])0\.31\.1([[:space:]]|$) ]] || return 4
  printf '%s\n' "$version"
}

runner_kimi_catalog() {
  # Живого machine-readable каталога у CLI нет; pinned models.tsv по KIMI.md
  # (managed:kimi-code, default kimi-code/k3). Release — порядок предпочтения,
  # default-модель выше. Окно совместимости min=max=0.31.1 — тот же fail-closed
  # пин, что в probe/classify.
  printf '%s\n' \
    $'kimi-code/k3\tkimi\tk3\t1\tdefault\t100\t1\t0\t1\t0.31.1\t0.31.1' \
    $'kimi-code/k3-256k\tkimi\tk3\t1\tdefault\t90\t1\t0\t1\t0.31.1\t0.31.1' \
    $'kimi-code/kimi-for-coding\tkimi\tkimi-for-coding\t1\tdefault\t80\t1\t0\t1\t0.31.1\t0.31.1' \
    $'kimi-code/kimi-for-coding-highspeed\tkimi\tkimi-for-coding-highspeed\t1\tdefault\t70\t1\t0\t1\t0.31.1\t0.31.1'
}

runner_kimi_default_policy() {
  # EFFORT намеренно не заявлен: флага effort у CLI нет (KIMI.md). Пустое поле
  # движок подменяет на high при запуске (multi-runner.sh) — значение инертно,
  # раннер его игнорирует и в argv не передаёт.
  printf 'FAMILY=k3\nVERSION=latest\nVARIANT=auto\n'
}

runner_kimi_family_alias() {
  # Каталог есть (см. runner_kimi_catalog), семейный alias не нужен.
  return 4
}

runner_kimi_capabilities() {
  # sandbox нет в списке намеренно: границы у голого `kimi -p` нет (принятый риск
  # редакции 2 плана), заявлять её было бы опаснее отсутствия. status_fd не
  # доказан spike — только request-транспорт через унаследованное env (KIMI.md).
  printf 'status status_request tools structured_output\n'
}

runner_kimi_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  # Промпт — только аргументом: stdin-форму `-p -` CLI не читает (доказано spike,
  # KIMI.md). Потолок ARG_MAX (~2 МБ на argv+env) на порядки выше конвейерных
  # промптов, отдельной защиты не делаем. effort в argv не передаём — флага нет.
  local -a args=(kimi -p "$prompt" --output-format stream-json)
  [[ -z "$model" ]] || args+=(-m "$model")
  local add_dir
  for add_dir in ${RUNNER_KIMI_ADD_DIRS:-}; do
    [[ -d "$add_dir" ]] && args+=(--add-dir "$add_dir")
  done
  # -k: см. комментарий в runners/claude.sh — TERM без последующего KILL оставляет
  # застрявшего провайдера жить с занятым слотом.
  factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
}

_runner_kimi_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_kimi_no_model_activity() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

try:
    source = open(sys.argv[1], encoding="utf-8", errors="replace")
except OSError:
    # Нет файла — как пустой поток (TERM до первого события, KIMI.md):
    # активности не зафиксировано.
    raise SystemExit(0)

for line in source:
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        # Повреждённый stream не доказывает, что работы не было.
        raise SystemExit(1)
    role = event.get("role", "")
    if role == "assistant":
        if event.get("content") or event.get("tool_calls"):
            raise SystemExit(1)
    elif role == "tool":
        raise SystemExit(1)
    # role=meta (session.resume_hint) — сериализация сессии, не активность.
raise SystemExit(0)
PYTHON
}

runner_kimi_classify() {
  local run_dir=$1 rc=$2 version verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(_runner_kimi_meta "$run_dir" CLI_VERSION)
  verified=$(_runner_kimi_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_kimi_meta "$run_dir" SOURCE)
  [[ "$version" == 0.31.1 ]] || { printf 'unknown\n'; return; }
  # Любая сигнатура допускается только из runtime или проверенной fixture.
  # Непроверенный текст ошибки остаётся unknown и никогда не меняет ИИ.
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  # Единственная доказанная сигнатура (KIMI.md): незалогиненный CLI. Строго
  # «No model configured … /login»: «is not configured in config.toml» — это
  # config.invalid несуществующей модели (fixture kimi-bad-model) и остаётся
  # unknown. Переключение — только при доказанном отсутствии model/tool
  # activity, иначе failover перезапустит уже частично выполненную стадию
  # (fixture kimi-auth-after-work).
  if grep -qE 'No model configured.*/login' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_kimi_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
  fi
  # Сигнатуры лимитов/401/403/413/429 spike не доказал — classify v1 их не
  # содержит: лимит Kimi уйдёт в unknown, стадия не переключится (fail-closed,
  # KIMI.md). При первом живом инциденте — снять stderr/events и добавить fixture.
  printf 'unknown\n'
}

runner_kimi_fanout_count() {
  printf '0\n'
}

runner_kimi_dialect() {
  printf 'Kimi stream-json: NDJSON role=assistant/tool/meta; terminal status through stage-result.\n'
}

runner_kimi_interrupt() {
  # CLI не создаёт собственную сессию: дерево остаётся в setsid-сессии launcher'а,
  # штатный quiesce достаточен (KIMI.md). По имени процесса убивать нельзя — на
  # хосте живут долгоживущие `kimi acp` процессы чат-рантайма Cockpit.
  return 0
}
