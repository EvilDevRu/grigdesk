#!/usr/bin/env bash
# Статусы конвейера фабрики: безопасная запись в state/tNNNN.pipeline.
#   pipeline-set.sh <TASK> --init [KEY=VAL ...]   — создать реестр со ВСЕМИ узлами (pending)
#   pipeline-set.sh <TASK> KEY VAL [KEY VAL ...]  — выставить статус(ы)
# Всегда upsert: отсутствующий ключ СОЗДАЁТСЯ (sed-замена по отсутствующему ключу —
# молчаливый no-op, из-за которого узел Ship не подсвечивается).
# STATE_DIR передаётся движком через env (по умолчанию ~/.factory/state)
STATE_DIR="${STATE_DIR:-$HOME/.factory/state}"
# Значение бывает свободным текстом (причина пропуска, замечание ревью), а уходит оно
# в sed-замену: «|» рвал бы саму команду, «&» подставлял бы весь найденный кусок, а перевод
# строки ломал бы формат KEY=VAL. Поэтому экранируем разметку и схлопываем переносы.
upsert() { local f=$1 k=$2 v=$3; v=${v//$'\n'/ }; local e=${v//\\/\\\\}; e=${e//&/\\&}; e=${e//|/\\|}; if grep -q "^${k}=" "$f" 2>/dev/null; then sed -i "s|^${k}=.*|${k}=${e}|" "$f"; else [[ -s "$f" && -n "$(tail -c1 "$f")" ]] && printf "\n" >> "$f"; printf "%s=%s\n" "$k" "$v" >> "$f"; fi; }

TASK=${1:?Использование: pipeline-set.sh <TASK> --init|KEY VAL ...}
shift
# Агенты зовут скрипт и как «<TASK>», и как «t<TASK>» (имя задачи они видят с префиксом в файлах).
# Без нормализации второй вариант создаёт реестр-призрак tt<TASK>.pipeline, отчёт этапа уходит
# в никуда, а движок считает этап неотчитавшимся и гоняет его заново.
TASK=${TASK#[tT]}
PF="$STATE_DIR/t${TASK}.pipeline"
mkdir -p "$STATE_DIR"

# Задача уже отгружена (реестр в архиве, живого нет) — писать в АРХИВ,
# иначе upsert создаст файл-призрак и дашборд «воскресит» задачу
if [[ ! -f "$PF" && -f "$STATE_DIR/archive/t${TASK}.pipeline" && "${1:-}" != "--init" ]]; then
  PF="$STATE_DIR/archive/t${TASK}.pipeline"
fi

# Terminal agent result принимается только через stage-result.sh с run capability.
if grep -q '^RUN_PROTOCOL=2$' "$PF" 2>/dev/null; then
  _arg=""
  for _arg in "$@"; do
    case "$_arg" in
      done|failed|skipped|RUN_PROTOCOL|ACTIVE_RUN_*|ACTIVE_EPOCH_*)
        echo "stale_run: terminal/control write requires protocol v2 API" >&2
        exit 73 ;;
    esac
  done
fi

if [[ "${1:-}" == "--replan" ]]; then
  shift
  # Новый круг планирования (reject ворот): хвост прошлого круга сбрасывается,
  # иначе граф показывает «тесты бегут при неутверждённом плане».
  # SCOUT НЕ сбрасываем: отклонён ПЛАН, а не разведка, поэтому повторный запуск
  # разведки впустую гонял бы её по новому кругу при неизменном коде.
  # PLAN (движковый ключ этапа) — ОБЯЗАТЕЛЬНО в списке рядом с PLANS (ключ подэтапа):
  # без него run_pipeline видел stale PLAN=done и пропускал планирование —
  # ворота открывались со СТАРЫМ, уже отклонённым планом.
  # DEMO в списке НЕТ: демо снимается вне конвейера, по кнопке плагина «Демо» в кокпите,
  # и его статусом распоряжается только режим `factory <TASK> demo`. Сбрасывать чужой ключ
  # за компанию — как раз то, из-за чего дашборд потом ждал этап, которого движок не гоняет.
  for k in PLAN PLANS SKEPTIC VALIDATE TRANSLATOR GATE_PLAN TESTS TCRITIC BUILD SIMPLIFY REVIEW TRACE PHPCHECK LINT \
           BROWSER GATE_ACCEPT SHIP RETRO; do
    upsert "$PF" "$k" "pending"
  done
  upsert "$PF" WF_STATUS "running"
fi

if [[ "${1:-}" == "--reject-accept" ]]; then
  shift
  # Приёмку отклонили: конвейер откатывается в Build. Тесты остаются заморожены,
  # всё от сборки и далее — заново (аналог --replan для этапа сборки)
  # MEASURE тоже сбрасываем: в маршруте debug это «замер ПОСЛЕ», и после новой правки
  # старые цифры недействительны. Без него отклонённая задача приезжает на приёмку
  # со «зелёным» замером от прошлой сборки.
  for k in BUILD SIMPLIFY REVIEW TRACE MEASURE PHPCHECK LINT BROWSER GATE_ACCEPT SHIP; do
    upsert "$PF" "$k" "pending"
  done
  upsert "$PF" BUILD "running"
fi

if [[ "${1:-}" == "--init" ]]; then
  shift
  touch "$PF"
  if [[ "${1:-}" == "--stages" ]]; then
    # Свой скелет узлов (route v2): ключи приходят из ЗАКРЕПЛЁННОГО бандла —
    # в реестре не должно быть узлов, которых нет в маршруте (v1-список ниже
    # рисовал в UI «пропущенные» несуществующие этапы).
    shift
    for k in ${1:-}; do
      [[ "$k" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || continue
      upsert "$PF" "$k" pending
      # Отметку времени перехода сбрасываем вместе со статусом: на recovery реестр
      # переинициализируется поверх прошлой попытки, и «GATE_PLAN=pending» с датой
      # позавчерашнего approve — ровно та подсказка, по которой человек жмёт не глядя.
      # ACTIVE_RUN_*/ACTIVE_EPOCH_* здесь НЕ трогаем: на них держится fencing старых
      # прогонов, сброс эпохи вернул бы к жизни убитый ход прошлой попытки.
      if grep -q "^${k}_AT=" "$PF" 2>/dev/null; then upsert "$PF" "${k}_AT" ""; fi
    done
    shift
    upsert "$PF" WF_STATUS running
  else
    # Полный v1-скелет: каждый узел графа обязан иметь ключ, иначе статусы теряются
    for kv in WF_STATUS=running SCOUT=pending PLANS=pending SKEPTIC=pending VALIDATE=pending \
              TRANSLATOR=pending GATE_PLAN=pending TESTS=pending TCRITIC=pending BUILD=pending \
              SIMPLIFY=pending REVIEW=pending TRACE=pending PHPCHECK=pending LINT=pending \
              GATE_CAUSE=pending GATE_ACCEPT=pending SHIP=pending RETRO=pending; do
      upsert "$PF" "${kv%%=*}" "${kv#*=}"
    done
  fi
fi

# Помимо статуса пишем телеметрию: KEY_AT (время перехода) для терминальных
# состояний и KEY_FAILS (счётчик петель) — сырьё для страницы /stats
set_kv() {
  local key=$1 val=$2
  upsert "$PF" "$key" "$val"
  case "$val" in
    done|failed|waiting|approved|rejected|skipped|running)
      upsert "$PF" "${key}_AT" "$(date '+%F %T')" ;;
    # У «ещё не было» времени перехода нет. Иначе решение, сброшенное в pending
    # (recovery, новый круг планирования), сохраняло дату прошлого approve —
    # и человек у ворот видел свежий на вид вердикт от позавчера.
    pending)
      if grep -q "^${key}_AT=" "$PF" 2>/dev/null; then upsert "$PF" "${key}_AT" ""; fi ;;
  esac
  if [[ "$val" == "failed" ]]; then
    local fails
    fails=$(grep "^${key}_FAILS=" "$PF" 2>/dev/null | cut -d= -f2 || true)
    upsert "$PF" "${key}_FAILS" "$(( ${fails:-0} + 1 ))"
  fi
}

while [[ $# -ge 1 ]]; do
  kv="$1"; shift
  if [[ "$kv" == *=* ]]; then
    set_kv "${kv%%=*}" "${kv#*=}"
  else
    val=${1-}; shift 2>/dev/null || true   # пустое значение допустимо (очистка ключа)
    set_kv "$kv" "$val"
  fi
done
grep -E '=' "$PF" | head -20
