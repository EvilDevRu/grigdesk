#!/usr/bin/env bash
# Скан сессии — единственное доказательство тишины раннера: пока в его сессии
# жив хоть один процесс, launcher не имеет права снимать trusted identity
# (регресс t8165 — TERM пережили claude, его MCP и docker). На живой машине
# процессы исчезают прямо во время обхода /proc, и скан обязан это переживать:
# «не смог прочитать чужой pid» никогда не равно «сессия пуста».
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

setsid bash -c 'while :; do sleep 1; done' &
victim=$!
# setsid отделяет процесс не мгновенно: до этого его сессия — сессия теста.
own=""
for _ in {1..500}; do
  identity=$(_runner_process_full_identity "$victim" 2>/dev/null || true)
  if [[ -n "$identity" ]]; then
    read -r v_pgid v_session v_start v_state v_ppid <<<"$identity"
    if [[ "$v_pgid" == "$victim" && "$v_session" == "$victim" ]]; then own=1; break; fi
  fi
  sleep 0.01
done
if [[ -z "$own" ]]; then
  test_fail "session scan survives disappearing processes" \
    "фоновый процесс $victim не стал лидером своей сессии"
  kill -KILL -- "-$victim" 2>/dev/null || true
  finish_tests
  exit $?
fi

# Поток короткоживущих процессов: каждый `$( )` — форк, который умирает сразу.
# Он и создаёт записи /proc, исчезающие между globом и чтением.
(
  for ((i = 0; i < 20000; i++)); do
    : "$(:)"
  done
) &
churn=$!

repeat=${TEST_REPEAT:-5}
scans=0
bad=""
for ((n = 1; n <= repeat * 40; n++)); do
  kill -0 "$churn" 2>/dev/null || break
  pgids=$(_runner_session_pgids "$victim")
  rc=$?
  scans=$((scans + 1))
  if (( rc != 0 )); then bad="rc=$rc"; break; fi
  # Живой процесс своей сессии обязан быть в выводе: именно на этот ответ
  # опирается решение «раннер затих».
  if [[ " $pgids " != *" $victim "* ]]; then bad="pgids=[$pgids]"; break; fi
done
kill -TERM "$churn" 2>/dev/null || true
wait "$churn" 2>/dev/null || true

scan_name="session scan survives disappearing processes"
if [[ -n "$bad" ]]; then
  test_fail "$scan_name" "$bad after $scans scans"
elif (( scans == 0 )); then
  test_fail "$scan_name" "ни одного скана не выполнено"
else
  test_ok "$scan_name"
fi

# Пустая сессия обязана оставаться пустой: иначе «тишина» стала бы недостижимой
# и раннер не завершался бы никогда.
kill -KILL -- "-$victim" 2>/dev/null || true
wait "$victim" 2>/dev/null || true
for _ in {1..200}; do
  _runner_session_pgids "$victim" >/dev/null || break
  sleep 0.01
done
_runner_session_pgids "$victim" >/dev/null
assert_rc 1 "$?" "empty session still reads as silence"

finish_tests
