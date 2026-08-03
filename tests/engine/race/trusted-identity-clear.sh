#!/usr/bin/env bash
# У trusted identity два законных уборщика: launcher (раннер умер) и оператор
# (`runner switch` погасил тот же раннер). Они снимают ОДНУ запись и встречаются
# в окне между проверкой файла и его чтением. Проигравший гонку обязан отвечать
# «уже снято» (0): иначе CLI отчитывался ошибкой об успешно состоявшемся
# переключении, а launcher ловил group_rc и подменял результат этапа на 76
# при полностью корректной работе.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

task=7701
stage=BUILD
run_id=run-clear
epoch=1
runner=alpha
pid=4321
starttime=7

file=$(runner_trusted_identity_file "$task") || {
  test_fail "trusted identity path resolves" "runner_trusted_identity_file rc=$?"
  finish_tests
  exit $?
}
dir=$(dirname "$file")
mkdir -p "$dir"
chmod 700 "$dir"

# Пишем ровно как publish: временный файл, chmod 600, атомарный mv. Запись
# фиксированная — уборщики в проде снимают именно свою, совпадающую поле в поле.
publish_identity() {
  local tmp
  tmp=$(mktemp "$dir/.runner-identity.XXXXXX") || return 1
  {
    printf 'SCHEMA=1\n'
    printf 'TASK=%s\n' "$task"
    printf 'STAGE=%s\n' "$stage"
    printf 'RUN_ID=%s\n' "$run_id"
    printf 'EPOCH=%s\n' "$epoch"
    printf 'RUNNER=%s\n' "$runner"
    printf 'PID=%s\n' "$pid"
    printf 'PGID=%s\n' "$pid"
    printf 'SESSION=%s\n' "$pid"
    printf 'STARTTIME=%s\n' "$starttime"
    printf 'STATE=active\n'
  } >"$tmp" || { rm -f -- "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$file"
}

clear_own() {
  runner_trusted_identity_clear "$task" "$stage" "$run_id" "$epoch" "$runner" \
    "$pid" "$pid" "$pid" "$starttime"
}

repeat=${TEST_REPEAT:-5}
bad_rc=""
bad_err=""
clears=0
present=0
absent=0
for ((n=1; n<=repeat; n++)); do
  rm -f -- "$file"
  (
    for ((w=0; w<200; w++)); do
      publish_identity || exit 1
      rm -f -- "$file"
    done
  ) &
  writer=$!
  while kill -0 "$writer" 2>/dev/null; do
    if [[ -e "$file" ]]; then present=$((present + 1)); else absent=$((absent + 1)); fi
    err=$(clear_own 2>&1 >/dev/null)
    rc=$?
    clears=$((clears + 1))
    # Единственный допустимый исход: запись снята нами или уже снята соседом.
    if (( rc != 0 )); then bad_rc="$rc"; break; fi
    if [[ -n "$err" ]]; then bad_err="$err"; break; fi
  done
  kill -TERM "$writer" 2>/dev/null || true
  wait "$writer" 2>/dev/null || true
  [[ -z "$bad_rc" && -z "$bad_err" ]] || break
done
rm -f -- "$file"

race_name="concurrent owners clearing one identity both report success"
if [[ -n "$bad_rc" ]]; then
  test_fail "$race_name" "rc=$bad_rc after $clears clears"
elif [[ -n "$bad_err" ]]; then
  test_fail "$race_name" "stderr=[$bad_err] after $clears clears"
elif (( present == 0 || absent == 0 )); then
  # Одна из веток ни разу не выполнялась — значит писатель не пересёкся с
  # уборщиком и тест ничего не проверил.
  test_fail "$race_name" \
    "writer never overlapped the cleaner (present=$present absent=$absent)"
else
  test_ok "$race_name"
fi

# Идемпотентность «уже снято» не должна превращаться в «снимаем что угодно»:
# чужой запуск остаётся чужим, и его identity уборщик не трогает.
publish_identity || test_fail "fixture publishes identity" "publish failed"
runner_trusted_identity_clear "$task" "$stage" run-other "$epoch" "$runner" \
  "$pid" "$pid" "$pid" "$starttime" >/dev/null 2>&1
assert_rc 73 "$?" "cleaner refuses an identity of another run"
assert_file_exists "$file" "refused clear leaves the foreign identity in place"
rm -f -- "$file"

finish_tests
