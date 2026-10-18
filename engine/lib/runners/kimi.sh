#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_kimi_probe() {
  local version
  command -v kimi >/dev/null 2>&1 || return 4
  version=$(factory_exec provider kimi --version) || return
  # Версия — диагностика конкретного run, а не допуск. Совместимость Kimi
  # обеспечивают terminal CAS и fail-closed classify: незнакомый отказ остаётся
  # unknown и не запускает стадию повторно только из-за смены semver.
  printf '%s\n' "$version"
}

runner_kimi_catalog() {
  # Живого machine-readable каталога у CLI нет; pinned models.tsv по KIMI.md
  # (managed:kimi-code, default kimi-code/k3). Release — порядок предпочтения,
  # default-модель выше. `*` в границах runtime означает совместимость по
  # контракту потока и классификатора, а не разрешение угадывать новые ошибки.
  printf '%s\n' \
    $'kimi-code/k3\tkimi\tk3\t1\tdefault\t100\t1\t0\t1\t*\t*' \
    $'kimi-code/k3-256k\tkimi\tk3\t1\tdefault\t90\t1\t0\t1\t*\t*' \
    $'kimi-code/kimi-for-coding\tkimi\tkimi-for-coding\t1\tdefault\t80\t1\t0\t1\t*\t*' \
    $'kimi-code/kimi-for-coding-highspeed\tkimi\tkimi-for-coding-highspeed\t1\tdefault\t70\t1\t0\t1\t*\t*'
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

# Effort у CLI нет ни argv-флагом, ни env (spike, KIMI.md), но `[thinking].effort`
# читается из config.toml при `-p`, а KIMI_CODE_HOME CLI уважает (fixture kimi-no-login).
# Поэтому effort применяется через per-run home: копия config.toml с переписанной
# секцией [thinking], credentials/oauth — symlink на дефолтный home (OAuth refresh
# обязан попадать в общее хранилище). CLI невалидный effort молча нормализует в high
# (проверено fixture `migrations-effort.json`), поэтому набор low|high|max раннер
# проверяет здесь fail-closed, до вызова модели.
_runner_kimi_prepare_home() {
  local run_home=$1 effort=$2
  local default_home=${KIMI_CODE_HOME:-"${HOME:?HOME or KIMI_CODE_HOME is required}/.kimi-code"}
  [[ -f "$default_home/config.toml" ]] || return 4
  mkdir -p "$run_home" || return 4
  chmod 700 "$run_home" 2>/dev/null || true
  local link
  for link in credentials oauth; do
    if [[ -e "$default_home/$link" ]]; then
      ln -sfn "$default_home/$link" "$run_home/$link" || return 4
    fi
  done
  if [[ -z "$effort" ]]; then
    cp -- "$default_home/config.toml" "$run_home/config.toml"
    return
  fi
  command -v python3 >/dev/null 2>&1 || return 4
  python3 - "$default_home/config.toml" "$run_home/config.toml" "$effort" <<'PYTHON'
import re
import sys

src, dst, effort = sys.argv[1], sys.argv[2], sys.argv[3]

with open(src, encoding="utf-8") as fh:
    lines = fh.read().splitlines()

out = []
section = None
thinking_seen = False
effort_written = False
for line in lines:
    stripped = line.strip()
    header = re.fullmatch(r"\[\s*([A-Za-z0-9_.\"-]+)\s*\]", stripped)
    if header:
        if section == "thinking" and not effort_written:
            out.append(f'effort = "{effort}"')
            effort_written = True
        section = header.group(1).split(".")[0].strip('"')
        thinking_seen = thinking_seen or section == "thinking"
    if section == "thinking" and re.match(r"effort\s*=", stripped):
        if not effort_written:
            out.append(f'effort = "{effort}"')
            effort_written = True
        continue
    out.append(line)

if section == "thinking" and not effort_written:
    out.append(f'effort = "{effort}"')
if not thinking_seen:
    out += ["", "[thinking]", "enabled = true", f'effort = "{effort}"']

with open(dst, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
PYTHON
}

runner_kimi_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  # Промпт — только аргументом: stdin-форму `-p -` CLI не читает (доказано spike,
  # KIMI.md). Потолок ARG_MAX (~2 МБ на argv+env) на порядки выше конвейерных
  # промптов, отдельной защиты не делаем.
  local -a args=(kimi -p "$prompt" --output-format stream-json)
  [[ -z "$model" ]] || args+=(-m "$model")
  if [[ -n "$effort" ]]; then
    case "$effort" in
      low|high|max) ;;
      *)
        echo "kimi effort не поддерживается: $effort (допустимы low|high|max)" >&2
        return 4
        ;;
    esac
  fi
  local run_home="$run_dir/kimi-home"
  _runner_kimi_prepare_home "$run_home" "$effort" || {
    echo "kimi per-run home не собран: $run_home" >&2
    return 4
  }
  local add_dir
  for add_dir in ${RUNNER_KIMI_ADD_DIRS:-}; do
    [[ -d "$add_dir" ]] && args+=(--add-dir "$add_dir")
  done
  # Поток CLI идёт в журнал через мост телеметрии: делегируя работу инструментом
  # `Agent`, kimi перестаёт писать в stdout вообще — ни вызова, ни событий субагентов.
  # Внутренний wire-журнал при этом продолжает получать события. Внешний журнал мог
  # надолго замирать при
  # здоровом ходе, а GrigDesk считает молчание по его свежести и звал человека зря.
  # Мост — единственный писатель: строки CLI переливаются байт-в-байт, события
  # субагентов вливаются между ними. Второй параллельный писатель в тот же fd
  # недопустим — строки CLI доходят до 32 КБ, это много больше PIPE_BUF.
  # Без python3 мост тихо пропускается: телеметрия субагентов не стоит отказа хода.
  local bridge="${FACTORY_HOME:?}/lib/runners/kimi-wire.py"
  # -k: см. комментарий в runners/claude.sh — TERM без последующего KILL оставляет
  # застрявшего провайдера жить с занятым слотом.
  if [[ -f "$bridge" ]] && command -v python3 >/dev/null 2>&1; then
    KIMI_CODE_HOME="$run_home" factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}" \
      | python3 "$bridge" --merge "$run_home"
    # Исход хода — только у CLI: сбой моста не имеет права стать отказом стадии.
    return "${PIPESTATUS[0]}"
  fi
  KIMI_CODE_HOME="$run_home" factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
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
  local run_dir=$1 rc=$2 verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  verified=$(_runner_kimi_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_kimi_meta "$run_dir" SOURCE)
  # Любая сигнатура допускается только из runtime или проверенной fixture.
  # Непроверенный текст ошибки остаётся unknown и никогда не меняет ИИ. Версия
  # намеренно не участвует: одинаковая доказанная сигнатура плюс отсутствие
  # model/tool activity безопасны при любом semver; новая форма уйдёт в unknown.
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
  # Исчерпанная квота биллингового цикла: доказана живым инцидентом на узле совета
  # (CLI 0.33.0, fixture kimi-usage-limit). Требуем ОБЕ части текста —
  # сам `provider.auth_error: 403` этого не доказывает: тем же кодом отвечает
  # отозванный или неверный токен, а он лечится не ожиданием, а входом.
  # Условие «модель не работала» то же, что у no-login: иначе предохранитель
  # запишет лимит по ходу, который частично выполнился, и следующий заход
  # переиграет уже сделанное.
  if grep -qE "provider\.auth_error: 403 .*usage limit" \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_kimi_no_model_activity "$run_dir"; then
      printf 'limited\n'
      return
    fi
  fi
  # Обрыв транспорта на обновлении OAuth-токена. Доказан 10 живыми инцидентами
  # (CLI 0.33.0, fixture kimi-oauth-transport): CLI помечает ошибку
  # `"retryable": false` и завершает ход целиком. Семь из десяти случились ПОСЛЕ
  # реальной работы — от 7,7 до 58,9 минут, 169 минут суммарно; в самом долгом ходе
  # wire-журнал насчитал 59 обращений к модели, и все они пропали вместе с ходом.
  #
  # Класс `transient` вместо прежнего молчаливого `unknown` не меняет механику
  # (ни он, ни unknown не переключают исполнителя — и правильно: работа модели уже
  # была, чужой заход переиграл бы её), но делает отказ ВИДИМЫМ: раньше в meta.env
  # стояло `RESULT_CLASS=unknown`, и отличить моргнувшую сеть от настоящей поломки
  # можно было только грепом по wire.jsonl внутри per-run home.
  #
  # Проверки «модель не работала» здесь нет намеренно: в этом отказе она как раз
  # работала, и такой guard исключил бы ровно тот случай, ради которого класс заведён.
  # Признак берём из ДВУХ частей сразу — адрес токен-эндпоинта и обрыв соединения:
  # один `OAuth request` покрыл бы и отозванный токен, который ожиданием не лечится.
  if grep -qE 'OAuth request to https://auth\.kimi\.com/api/oauth/token failed' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null &&
     grep -qE 'fetch failed|socket disconnected|ECONNRESET|ETIMEDOUT|EAI_AGAIN' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'transient\n'
    return
  fi
  # Остальные сигнатуры лимитов/401/413/429 spike не доказал: они уходят в unknown,
  # стадия не переключается (fail-closed, KIMI.md). При новом живом инциденте —
  # снять stderr/events и добавить fixture рядом.
  printf 'unknown\n'
}

runner_kimi_fanout_count() {
  local run_dir=$1
  local bridge="${FACTORY_HOME:?}/lib/runners/kimi-wire.py"
  # Считать по events.jsonl нечего: вызовов `Agent` там не бывает вовсе (см.
  # runner_kimi_run). Источник — wire.jsonl per-run home, и разбирается он как
  # JSON, а не грепом: `llm.tools_snapshot` несёт ОПИСАНИЕ инструмента Agent,
  # поэтому греп по имени дал бы ненулевой fanout на ходе без делегирований.
  if [[ -f "$bridge" ]] && command -v python3 >/dev/null 2>&1; then
    python3 "$bridge" --fanout "$run_dir/kimi-home" 2>/dev/null && return 0
  fi
  printf '0\n'
}

runner_kimi_dialect() {
  printf 'Kimi stream-json: NDJSON role=assistant/tool/meta; terminal status through stage-result.\n'
}

runner_kimi_interrupt() {
  # CLI не создаёт собственную сессию: дерево остаётся в setsid-сессии launcher'а,
  # штатный quiesce достаточен (KIMI.md). По имени процесса убивать нельзя — на
  # хосте живут долгоживущие `kimi acp` процессы чат-рантайма GrigDesk.
  return 0
}
