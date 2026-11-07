#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/profile-preflight.sh"

# Инцидент 27.08.2026: снимок покрытия ОБЩИЙ на профиль, а пишет его любой
# start/resume. Одна моргнувшая проба чужого resume записала `UNAVAILABLE=2`, и
# идущий рядом прогон встал fail-closed на следующем узле. Проба идемпотентна,
# поэтому лечится повтором с паузой — но только транзиент.
#
# Счётчики живут в файлах, а не в переменных: подстановка `$(…)` уносит вызов в
# подоболочку, и присвоенная там переменная до теста не доезжает.

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
PROBE_LOG="$work/calls"
SLEEP_LOG="$work/sleeps"

runner_call() {
  local index
  index=$(wc -l <"$PROBE_LOG")
  printf 'call\n' >>"$PROBE_LOG"
  local step=${PROBE_SCRIPT[index]:-${PROBE_SCRIPT[-1]}}
  case "$step" in
    ok) printf 'cli 1.2.3\n'; return 0 ;;
    *) return "$step" ;;
  esac
}

_profile_preflight_probe_sleep() {
  printf '%s\n' "$1" >>"$SLEEP_LOG"
}

reset_probe() {
  : >"$PROBE_LOG"
  : >"$SLEEP_LOG"
  PROBE_SCRIPT=("$@")
}

calls() {
  wc -l <"$PROBE_LOG" | tr -d ' '
}

sleeps() {
  wc -l <"$SLEEP_LOG" | tr -d ' '
}

reset_probe ok
out=$(_profile_preflight_probe codex 2>/dev/null)
assert_rc 0 "$?" "исправная проба принимается"
assert_eq 'cli 1.2.3' "$out" "вывод пробы возвращается вызывающему"
assert_eq 1 "$(calls)" "исправная проба не повторяется"
assert_eq 0 "$(sleeps)" "успех с первой попытки не платит паузой"

reset_probe 1 ok
out=$(_profile_preflight_probe codex 2>/dev/null)
assert_rc 0 "$?" "моргнувшая проба лечится повтором"
assert_eq 'cli 1.2.3' "$out" "повтор возвращает вывод успешной попытки"
assert_eq 2 "$(calls)" "после транзиента делается ровно один повтор"
assert_eq 1 "$(sleeps)" "повтор ждёт паузу"
assert_eq 0.5 "$(sed -n 1p "$SLEEP_LOG")" "первая пауза не нулевая"

reset_probe 1 1 ok
_profile_preflight_probe codex >/dev/null 2>&1
assert_rc 0 "$?" "две подряд моргнувшие пробы ещё лечатся"
assert_eq 3 "$(calls)" "повторов ровно два"
assert_eq 1.5 "$(sed -n 2p "$SLEEP_LOG")" "пауза между попытками растёт"

reset_probe 1
_profile_preflight_probe codex >/dev/null 2>&1
assert_rc 1 "$?" "постоянный отказ остаётся отказом"
assert_eq 3 "$(calls)" "число попыток ограничено"
assert_eq 2 "$(sleeps)" "лишних пауз нет"

for code in 4 2 126; do
  reset_probe "$code"
  _profile_preflight_probe codex >/dev/null 2>&1
  assert_rc "$code" "$?" "детерминированный отказ $code возвращается как есть"
  assert_eq 1 "$(calls)" "детерминированный отказ $code ожиданием не лечится"
done

reset_probe 1 ok
warn=$(_profile_preflight_probe codex 2>&1 >/dev/null)
assert_eq 1 "$(grep -c 'проба codex ответила с попытки 2' <<<"$warn")" \
  "моргание названо в журнале запуска"

reset_probe ok
warn=$(_profile_preflight_probe codex 2>&1 >/dev/null)
assert_eq '' "$warn" "проба с первой попытки журнал не засоряет"

# Несовместимость поставки: детерминированный отказ пробы с маркером раннера
# собирается в PREFLIGHT_SUPPLY_INCOMPATIBLE в основном процессе, исходный stderr
# причин проходит вызывающему, повторов детерминированный отказ не получает.
PREFLIGHT_SUPPLY_INCOMPATIBLE=''
glm_supply_marker() {
  printf 'RUNNER_SUPPLY_INCOMPATIBLE=glm\n' >&2
  printf '{"code":"deepseek_binary_incompatible","error":"синтетика"}\n' >&2
  return 4
}
runner_call() { glm_supply_marker; }
_profile_preflight_probe glm >"$work/supply-out" 2>"$work/supply-err"
assert_rc 4 "$?" "несовместимость поставки — код 4 без повторов"
assert_eq 'glm' "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "маркер раннера собран в глобаль"
assert_contains "$(cat -- "$work/supply-err")" 'deepseek_binary_incompatible' \
  "исходный stderr причин проходит наружу"

# Проба без маркера не меняет накопленный список текущего preflight.
# Сброс выполняется только на входе в profile_runner_host_preflight.
PREFLIGHT_SUPPLY_INCOMPATIBLE='glm'
runner_call() {
  printf '{"code":"glm_runtime_not_admitted"}\n' >&2
  return 4
}
_profile_preflight_probe kimi >"$work/supply-out2" 2>/dev/null
assert_rc 4 "$?" "прочий детерминированный отказ — тот же код"
assert_eq 'glm' "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "маркер не растёт от чужих отказов"

# Только строгий маркер самого проверяемого раннера при rc=4 даёт перепривязку.
# Чужое имя, пояснение в той же строке и другие коды отказа её не разрешают.
runner_call() {
  printf '%s\n' "$probe_marker" >&2
  return "$probe_rc"
}
for probe_marker in 'RUNNER_SUPPLY_INCOMPATIBLE=kimi' 'RUNNER_SUPPLY_INCOMPATIBLE=glm (код)'; do
  probe_rc=4
  PREFLIGHT_SUPPLY_INCOMPATIBLE=''
  _profile_preflight_probe glm >/dev/null 2>&1
  assert_eq '' "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "неподходящий маркер не принят: $probe_marker"
done
for probe_rc in 0 2 126; do
  probe_marker='RUNNER_SUPPLY_INCOMPATIBLE=glm'
  PREFLIGHT_SUPPLY_INCOMPATIBLE=''
  _profile_preflight_probe glm >/dev/null 2>&1
  assert_eq '' "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "маркер при rc=$probe_rc не даёт перепривязку"
done
unset -f runner_call
source "$FACTORY_HOME/lib/runners/index.sh"

# Настоящий профильный вызов должен сохранить глобаль за границей захвата stdout.
# Второй вызов с готовым раннером обязан сбросить прежний список несовместимости.
export FACTORY_RUNNERS_DIR="$work/runners"
export FACTORY_PROFILES_DIR="$work/profiles"
mkdir -p "$FACTORY_RUNNERS_DIR" "$FACTORY_PROFILES_DIR/supply"
cp "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh" "$FACTORY_RUNNERS_DIR/alpha.sh"
cat >>"$FACTORY_RUNNERS_DIR/alpha.sh" <<'RUNNER'
runner_alpha_probe() {
  if [[ "${SUPPLY_PROBE:-incompatible}" == ready ]]; then
    printf '1.2.3\n'
    return 0
  fi
  printf 'RUNNER_SUPPLY_INCOMPATIBLE=alpha\n' >&2
  return 4
}
RUNNER
printf '%s\n' \
  RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=alpha \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture MODEL_DEFAULT_ALPHA_VERSION=latest \
  >"$FACTORY_PROFILES_DIR/supply/runners.env"
profile_runner_host_preflight supply 100 60 >/dev/null 2>"$work/host-err"
assert_rc 1 "$?" "несовместимая поставка блокирует профильный preflight"
assert_eq alpha "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "глобаль переживает захват stdout профильной пробы"
SUPPLY_PROBE=ready
profile_runner_host_preflight supply 200 60 >/dev/null 2>&1
assert_rc 0 "$?" "новый preflight принимает готового раннера"
assert_eq '' "$PREFLIGHT_SUPPLY_INCOMPATIBLE" "каждый профильный preflight очищает глобаль"

finish_tests
