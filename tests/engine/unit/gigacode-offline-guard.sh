#!/usr/bin/env bash
# Синтетические исполняемые файлы проверяют только границу offline-запуска.
# Протокол и ответы настоящего GigaCode здесь не моделируются.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/executor.sh"

assert_eq 1 "${FACTORY_FORBID_LIVE:-}" "сторож включён окружением offline-suite"

fixture_dir="$TEST_ROOT/cli с пробелами"
marker="$TEST_ROOT/gigacode-executed"
mkdir -p "$fixture_dir"

# Маркер доказывает, что отказ случился до исполнения, а не внутри заглушки.
# Все проверяемые пути принадлежат этому тесту и не требуют установленного CLI.
for name in gigacode gigacode-preview fixture-wrapper; do
  cat >"$fixture_dir/$name" <<'SH'
#!/usr/bin/env bash
printf 'executed\n' >>"$1"
exit 31
SH
  chmod +x "$fixture_dir/$name"
done

factory_exec provider "$fixture_dir/fixture-wrapper" "$marker" >"$TEST_ROOT/provider.log" 2>&1
assert_rc 126 "$?" "обёртка provider блокируется независимо от basename"
assert_file_missing "$marker" "provider не исполнялся"

for name in gigacode gigacode-preview; do
  marker="$TEST_ROOT/$name-provider-executed"
  factory_exec provider "$fixture_dir/$name" "$marker" >"$TEST_ROOT/$name-provider.log" 2>&1
  assert_rc 126 "$?" "$name запрещён как provider"
  assert_file_missing "$marker" "$name как provider не исполнялся"

  marker="$TEST_ROOT/$name-local-executed"
  factory_exec local "$fixture_dir/$name" "$marker" >"$TEST_ROOT/$name-local.log" 2>&1
  assert_rc 126 "$?" "$name запрещён при ложном kind=local и абсолютном пути"
  assert_file_missing "$marker" "$name как local не исполнялся"
done

marker="$TEST_ROOT/path-executed"
PATH="$fixture_dir:$PATH" factory_exec local gigacode "$marker" >"$TEST_ROOT/path.log" 2>&1
assert_rc 126 "$?" "короткое имя gigacode не обходит сторож через PATH"
assert_file_missing "$marker" "запуск через PATH не исполнялся"

marker="$TEST_ROOT/local-executed"
factory_exec local "$fixture_dir/fixture-wrapper" "$marker" >"$TEST_ROOT/local.log" 2>&1
assert_rc 31 "$?" "обычная локальная утилита сохраняет свой код возврата"
assert_eq executed "$(cat "$marker")" "локальная контрольная утилита действительно исполнилась"

"$FACTORY_TESTS_HOME/fakes/bin/gigacode" >"$TEST_ROOT/tripwire.log" 2>&1
assert_rc 97 "$?" "прямой вызов tripwire завершается отдельным кодом 97"
assert_contains "$(cat "$TEST_ROOT/tripwire.log")" OFFLINE_GUARD "tripwire объясняет запрет"

finish_tests
