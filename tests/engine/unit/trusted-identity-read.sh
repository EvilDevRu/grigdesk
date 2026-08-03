#!/usr/bin/env bash
# Trusted identity — единственный источник, по которому кокпит и CLI гасят чужой
# процесс. STATE_DIR намеренно пишет провайдер, поэтому запись читается только из
# control root и только при полном совпадении протокола: свой владелец, права 600,
# ровно одна жёсткая ссылка, не симлинк, 11 строк точного формата. Здесь
# зафиксированы отказы: ослабить любую из проверок — значит позволить подменить
# цель сигнала.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

task=91
file=$(runner_trusted_identity_file "$task") || {
  test_fail "trusted identity path resolves" "runner_trusted_identity_file rc=$?"
  finish_tests
  exit $?
}
dir=$(dirname "$file")
mkdir -p "$dir"
chmod 700 "$dir"

write_identity() {
  local target=$1 state=${2:-active}
  {
    printf 'SCHEMA=1\n'
    printf 'TASK=%s\n' "$task"
    printf 'STAGE=BUILD\n'
    printf 'RUN_ID=run-unit\n'
    printf 'EPOCH=1\n'
    printf 'RUNNER=alpha\n'
    printf 'PID=4242\n'
    printf 'PGID=4242\n'
    printf 'SESSION=4242\n'
    printf 'STARTTIME=99\n'
    printf 'STATE=%s\n' "$state"
  } >"$target"
  chmod 600 "$target"
}

rm -f -- "$file"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 3 "$?" "missing record reads as absent identity"

write_identity "$file"
record=$(runner_trusted_identity_read "$task")
assert_rc 0 "$?" "well-formed record is trusted"
assert_eq "BUILD run-unit 1 alpha 4242 4242 4242 99" "$record" \
  "trusted record exposes the exact process identity"

runner_trusted_identity_read "$task" BUILD run-other 1 >/dev/null 2>&1
assert_rc 73 "$?" "record of another run is not the requested one"

chmod 644 "$file"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "world-readable record is not trusted"
chmod 600 "$file"

# Лишняя жёсткая ссылка означает, что запись доступна под другим путём и её
# подменит тот, кто владеет каталогом со ссылкой.
ln -f -- "$file" "$TEST_ROOT/identity-hardlink"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "extra hard link makes the record untrusted"
rm -f -- "$TEST_ROOT/identity-hardlink"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 0 "$?" "record is trusted again once the extra link is gone"

rm -f -- "$file"
write_identity "$TEST_ROOT/identity-elsewhere"
ln -s -- "$TEST_ROOT/identity-elsewhere" "$file"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "symlinked record is not trusted"
rm -f -- "$file" "$TEST_ROOT/identity-elsewhere"

write_identity "$file" retired
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "non-active record is not a live runner"

write_identity "$file"
printf 'EXTRA=1\n' >>"$file"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "record with an extra line is not trusted"

write_identity "$file"
sed -i 's/^PGID=.*/PGID=17/' "$file"
runner_trusted_identity_read "$task" >/dev/null 2>&1
assert_rc 78 "$?" "record whose pid, pgid and session disagree is not trusted"

rm -f -- "$file"
finish_tests
