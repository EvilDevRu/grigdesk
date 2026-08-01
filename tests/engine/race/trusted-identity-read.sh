#!/usr/bin/env bash
# Читатель trusted identity против publish/clear: снятие файла под читателем —
# штатная часть протокола, и отвечать на неё «идентити недоверена» (78) нельзя,
# иначе `factory <task> runner switch` падает под нагрузкой.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

task=7700
file=$(runner_trusted_identity_file "$task") || {
  test_fail "trusted identity path resolves" "runner_trusted_identity_file rc=$?"
  finish_tests
  exit $?
}
dir=$(dirname "$file")
mkdir -p "$dir"
chmod 700 "$dir"

# Пишем ровно как publish: временный файл, chmod 600, атомарный mv. Иначе читатель
# ловил бы полузаписанный файл, и тест ругался бы на собственную неаккуратность.
publish_identity() {
  local pid=$1 tmp
  tmp=$(mktemp "$dir/.runner-identity.XXXXXX") || return 1
  {
    printf 'SCHEMA=1\n'
    printf 'TASK=%s\n' "$task"
    printf 'STAGE=BUILD\n'
    printf 'RUN_ID=run-race\n'
    printf 'EPOCH=1\n'
    printf 'RUNNER=alpha\n'
    printf 'PID=%s\n' "$pid"
    printf 'PGID=%s\n' "$pid"
    printf 'SESSION=%s\n' "$pid"
    printf 'STARTTIME=1\n'
    printf 'STATE=active\n'
  } >"$tmp" || { rm -f -- "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$file"
}

repeat=${TEST_REPEAT:-5}
bad_rc=""
bad_err=""
reads=0
absent=0
for ((n=1; n<=repeat; n++)); do
  rm -f -- "$file"
  (
    for ((w=0; w<120; w++)); do
      publish_identity $((1000 + w)) || exit 1
      rm -f -- "$file"
    done
  ) &
  writer=$!
  while kill -0 "$writer" 2>/dev/null; do
    err=$(runner_trusted_identity_read "$task" 2>&1 >/dev/null)
    rc=$?
    reads=$((reads + 1))
    (( rc == 3 )) && absent=$((absent + 1))
    # 0 — прочитали живую запись, 3 — записи нет. Всё остальное означает, что
    # обычная конкурентная смена файла выдана за нарушение доверия.
    if (( rc != 0 && rc != 3 )); then bad_rc="$rc"; break; fi
    if [[ -n "$err" ]]; then bad_err="$err"; break; fi
  done
  kill -TERM "$writer" 2>/dev/null || true
  wait "$writer" 2>/dev/null || true
  [[ -z "$bad_rc" && -z "$bad_err" ]] || break
done
rm -f -- "$file"

if [[ -n "$bad_rc" ]]; then
  test_fail "concurrent clear reads as absent identity, not as untrusted one" \
    "rc=$bad_rc after $reads reads"
elif [[ -n "$bad_err" ]]; then
  test_fail "concurrent clear reads as absent identity, not as untrusted one" \
    "stderr=[$bad_err] after $reads reads"
elif (( absent == 0 )); then
  # Ни одного «файла нет» — значит гонки не было вовсе и тест ничего не проверил.
  test_fail "concurrent clear reads as absent identity, not as untrusted one" \
    "writer never overlapped the reader ($reads reads)"
else
  test_ok "concurrent clear reads as absent identity, not as untrusted one"
fi
finish_tests
