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

finish_tests
