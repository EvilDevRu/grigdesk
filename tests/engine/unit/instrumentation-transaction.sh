#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/instrumentation-transaction.sh"
control_dir=$(factory_control_root)

main_repo="$TEST_ROOT/work/main"
repo="$TEST_ROOT/work/instrumentation-worktree"
mkdir -p "$main_repo"
git -C "$main_repo" init -q
git -C "$main_repo" config user.name fixture
git -C "$main_repo" config user.email fixture@example.test
printf 'чистое\n' >"$main_repo/tracked.txt"
printf 'индекс baseline\n' >"$main_repo/indexed.txt"
printf 'ignored-*\n' >"$main_repo/.gitignore"
git -C "$main_repo" add tracked.txt indexed.txt .gitignore
git -C "$main_repo" commit -qm baseline
git -C "$main_repo" worktree add -qb instrumentation-fixture "$repo"

# Транзакция начинается поверх реальной работы задачи, а не только на clean checkout.
printf 'работа задачи до trace\n' >"$repo/tracked.txt"
printf 'staged задачи до trace\n' >"$repo/indexed.txt"
git -C "$repo" add indexed.txt
printf 'untracked задачи до trace\n' >"$repo/existing.tmp"
ln -s tracked.txt "$repo/existing.link"

scope="$TEST_ROOT/scope.list"
printf '%s\n' \
  "$repo/tracked.txt" \
  "$repo/indexed.txt" \
  "$repo/existing.tmp" \
  "$repo/new-trace.tmp" >"$scope"

unset FACTORY_INSTRUMENTATION_ISOLATION
instrumentation_tx_begin 41 trace-no-isolation "$scope" 'FACTORY-TRACE:t41' "$repo"
assert_rc 78 "$?" "transaction refuses a workspace without trusted host isolation"
export FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1

instrumentation_tx_begin 42 trace-1 "$scope" 'FACTORY-TRACE:t42' "$repo"
assert_rc 0 "$?" "transaction captures an exact dirty baseline"
assert_file_exists "$control_dir/transactions/t42/active.env" \
  "transaction publishes an active pointer"

printf 'работа задачи до trace\n// FACTORY-TRACE:t42\n' >"$repo/tracked.txt"
printf 'trace staged\n' >"$repo/indexed.txt"
git -C "$repo" add indexed.txt
printf 'trace untracked\n' >"$repo/existing.tmp"
printf 'новый trace\n' >"$repo/new-trace.tmp"

instrumentation_tx_checkpoint 42 trace-1
assert_rc 0 "$?" "checkpoint accepts changes restricted to declared scope"
instrumentation_tx_cleanup 42 trace-1
assert_rc 0 "$?" "cleanup restores transaction-owned changes"
assert_eq "работа задачи до trace" "$(cat "$repo/tracked.txt")" \
  "cleanup restores pre-existing dirty tracked content"
assert_eq "staged задачи до trace" "$(cat "$repo/indexed.txt")" \
  "cleanup restores staged working content"
assert_eq "staged задачи до trace" "$(git -C "$repo" show :indexed.txt)" \
  "cleanup restores the exact index"
assert_eq "untracked задачи до trace" "$(cat "$repo/existing.tmp")" \
  "cleanup restores an existing untracked file"
assert_eq "tracked.txt" "$(readlink "$repo/existing.link")" \
  "cleanup leaves an out-of-scope symlink untouched"
assert_file_missing "$repo/new-trace.tmp" \
  "cleanup removes only a transaction-owned new file"
assert_file_missing "$control_dir/transactions/t42/active.env" \
  "completed transaction clears its active pointer"
printf 'SCHEMA=1\nTRANSACTION_ID=trace-1\n' >"$control_dir/transactions/t42/active.env"
instrumentation_tx_cleanup 42 trace-1
assert_rc 0 "$?" "cleanup repairs a crash after durable completion"
assert_file_missing "$control_dir/transactions/t42/active.env" \
  "completed-state repair removes the stale active pointer"

# После checkpoint любое неизвестное изменение превращает cleanup в CAS-конфликт.
instrumentation_tx_begin 42 trace-2 "$scope" 'FACTORY-TRACE:t42' "$repo"
assert_rc 0 "$?" "second transaction starts after completed cleanup"
printf 'trace second\n' >"$repo/tracked.txt"
instrumentation_tx_checkpoint 42 trace-2
assert_rc 0 "$?" "second transaction records expected state"
printf 'чужая параллельная правка\n' >"$repo/tracked.txt"
instrumentation_tx_cleanup 42 trace-2
assert_rc 75 "$?" "cleanup refuses a concurrent change"
assert_eq "чужая параллельная правка" "$(cat "$repo/tracked.txt")" \
  "CAS conflict never overwrites the concurrent content"
assert_eq stalled "$(_instrumentation_tx_get "$control_dir/transactions/t42/trace-2/state.env" STATE)" \
  "conflicted transaction is explicitly stalled"

# SIGKILL после первого restore оставляет durable cleaning state. Повтор принимает
# только смесь expected/baseline и идемпотентно доводит очистку до конца.
instrumentation_tx_begin 47 trace-crash "$scope" 'FACTORY-TRACE:t47' "$repo"
assert_rc 0 "$?" "crash-resume transaction starts"
printf 'trace crash existing\n' >"$repo/existing.tmp"
printf 'trace crash\n// FACTORY-TRACE:t47\n' >"$repo/tracked.txt"
printf 'trace crash new\n' >"$repo/new-trace.tmp"
instrumentation_tx_checkpoint 47 trace-crash
assert_rc 0 "$?" "crash-resume transaction records expected state"
(
  FACTORY_INSTRUMENTATION_TEST_CRASH_AFTER_RESTORE_OBJECTS=1 \
    instrumentation_tx_cleanup 47 trace-crash
)
assert_rc 137 "$?" "fault injection kills cleanup after a partial restore"
assert_eq cleaning \
  "$(_instrumentation_tx_get "$control_dir/transactions/t47/trace-crash/state.env" STATE)" \
  "partial restore retains durable cleaning state"
assert_eq "untracked задачи до trace" "$(cat "$repo/existing.tmp")" \
  "first restored object already matches baseline"
assert_contains "$(cat "$repo/tracked.txt")" "FACTORY-TRACE:t47" \
  "a later object still matches the pre-cleanup snapshot"
instrumentation_tx_cleanup 47 trace-crash
assert_rc 0 "$?" "cleanup resumes from a valid expected/baseline mixture"
assert_eq "чужая параллельная правка" "$(cat "$repo/tracked.txt")" \
  "resumed cleanup restores the transaction baseline"
assert_eq "untracked задачи до trace" "$(cat "$repo/existing.tmp")" \
  "resumed cleanup keeps an already restored object"
assert_file_missing "$repo/new-trace.tmp" \
  "resumed cleanup removes a transaction-owned new file"
assert_eq completed \
  "$(_instrumentation_tx_get "$control_dir/transactions/t47/trace-crash/state.env" STATE)" \
  "resumed cleanup reaches durable completion"

# Неизвестная правка во время cleaning не маскируется как частичный restore:
# вся проверка выполняется до продолжения записи.
instrumentation_tx_begin 48 trace-crash-conflict "$scope" 'FACTORY-TRACE:t48' "$repo"
assert_rc 0 "$?" "conflict-resume transaction starts"
printf 'trace conflict existing\n' >"$repo/existing.tmp"
printf 'trace conflict\n// FACTORY-TRACE:t48\n' >"$repo/tracked.txt"
instrumentation_tx_checkpoint 48 trace-crash-conflict
assert_rc 0 "$?" "conflict-resume transaction records expected state"
(
  FACTORY_INSTRUMENTATION_TEST_CRASH_AFTER_RESTORE_OBJECTS=1 \
    instrumentation_tx_cleanup 48 trace-crash-conflict
)
assert_rc 137 "$?" "second fault injection leaves a partial restore"
printf 'неизвестная правка во время cleaning\n' >"$repo/tracked.txt"
instrumentation_tx_cleanup 48 trace-crash-conflict
assert_rc 75 "$?" "resume refuses an object outside expected and baseline"
assert_eq "неизвестная правка во время cleaning" "$(cat "$repo/tracked.txt")" \
  "resume conflict is detected before overwriting the unknown edit"
assert_eq stalled \
  "$(_instrumentation_tx_get "$control_dir/transactions/t48/trace-crash-conflict/state.env" STATE)" \
  "unknown edit moves the cleaning transaction to stalled"

# Изменение вне scope не может стать новым expected checkpoint.
rm -f "$control_dir/transactions/t42/active.env"
printf 'чужая параллельная правка\n' >"$repo/tracked.txt"
instrumentation_tx_begin 42 trace-3 "$scope" 'FACTORY-TRACE:t42' "$repo"
assert_rc 0 "$?" "third transaction starts from a new accepted baseline"
printf 'trace third\n' >"$repo/tracked.txt"
printf 'вне scope\n' >"$repo/outside.txt"
instrumentation_tx_checkpoint 42 trace-3
assert_rc 75 "$?" "checkpoint rejects an out-of-scope file"

# Идентификаторы и scope валидируются до появления transaction state.
instrumentation_tx_begin '../../escape' trace-x "$scope" 'FACTORY-TRACE:tescape' "$repo"
assert_rc 2 "$?" "task id cannot escape the transaction state directory"

instrumentation_tx_begin 0 trace-x "$scope" 'FACTORY-TRACE:t0' "$repo"
assert_rc 2 "$?" "task id must be a positive factory task number"

instrumentation_tx_begin 43 trace-x "$scope" 'shared-debug-marker' "$repo"
assert_rc 2 "$?" "instrumentation marker must be task-scoped"

printf '%s\n' "$repo/../outside.txt" >"$TEST_ROOT/traversal.scope"
instrumentation_tx_begin 43 trace-x "$TEST_ROOT/traversal.scope" 'FACTORY-TRACE:t43' "$repo"
assert_rc 2 "$?" "lexical parent traversal is rejected from scope"

mkdir -p "$TEST_ROOT/outside"
ln -s "$TEST_ROOT/outside" "$repo/link-parent"
printf '%s\n' "$repo/link-parent/new.txt" >"$TEST_ROOT/symlink-parent.scope"
instrumentation_tx_begin 44 trace-x "$TEST_ROOT/symlink-parent.scope" 'FACTORY-TRACE:t44' "$repo"
assert_rc 2 "$?" "scope cannot escape through a symlink parent"

printf 'внешний файл\n' >"$TEST_ROOT/outside-target.txt"
ln -s "$TEST_ROOT/outside-target.txt" "$repo/link-target"
printf '%s\n' "$repo/link-target" >"$TEST_ROOT/symlink-target.scope"
instrumentation_tx_begin 44 trace-link "$TEST_ROOT/symlink-target.scope" 'FACTORY-TRACE:t44' "$repo"
assert_rc 2 "$?" "scope rejects a symlink as its final component"
assert_eq "внешний файл" "$(cat "$TEST_ROOT/outside-target.txt")" \
  "rejected symlink scope cannot alter an external target"

printf '%s\n' 'старый FACTORY-TRACE:t45 маркер' >"$repo/stale-marker.txt"
printf '%s\n' "$repo/tracked.txt" >"$TEST_ROOT/marker.scope"
instrumentation_tx_begin 45 trace-x "$TEST_ROOT/marker.scope" 'FACTORY-TRACE:t45' "$repo"
assert_rc 78 "$?" "a pre-existing task marker blocks a new transaction"

printf '%s\n' 'ignored FACTORY-TRACE:t46 маркер' >"$repo/ignored-marker"
instrumentation_tx_begin 46 trace-x "$TEST_ROOT/marker.scope" 'FACTORY-TRACE:t46' "$repo"
assert_rc 78 "$?" "a marker in an ignored source file also blocks a transaction"

# Scope нельзя превратить в symlink после begin: такая запись уже могла уйти
# за пределы worktree, поэтому checkpoint обязан остановиться и не объявлять cleanup успешным.
rm -f "$repo/stale-marker.txt" "$repo/ignored-marker"
printf '%s\n' "$repo/tracked.txt" >"$TEST_ROOT/runtime-symlink.scope"
instrumentation_tx_begin 49 trace-runtime-link "$TEST_ROOT/runtime-symlink.scope" \
  'FACTORY-TRACE:t49' "$repo"
assert_rc 0 "$?" "runtime-symlink transaction starts from a regular scope file"
printf 'внешний baseline\n' >"$TEST_ROOT/runtime-link-target.txt"
rm -f "$repo/tracked.txt"
ln -s "$TEST_ROOT/runtime-link-target.txt" "$repo/tracked.txt"
printf 'внешняя подмена\n' >"$repo/tracked.txt"
instrumentation_tx_checkpoint 49 trace-runtime-link
assert_rc 75 "$?" "checkpoint fails closed when a scope file becomes a symlink"
instrumentation_tx_cleanup 49 trace-runtime-link
assert_rc 73 "$?" "stalled symlink transaction cannot report successful cleanup"
rm -f "$repo/tracked.txt"
printf 'чужая параллельная правка\n' >"$repo/tracked.txt"

# Ignored не означает разрешённый: незаявленная правка такого файла тоже меняет
# baseline source tree и должна блокировать checkpoint.
printf 'ignored baseline\n' >"$repo/ignored-runtime"
instrumentation_tx_begin 50 trace-ignored "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t50' "$repo"
assert_rc 0 "$?" "ignored-inventory transaction starts"
printf 'ignored changed without marker\n' >"$repo/ignored-runtime"
instrumentation_tx_checkpoint 50 trace-ignored
assert_rc 75 "$?" "checkpoint rejects an ignored out-of-scope change"

# --- изменчивые пути, объявленные профилем (PROFILE_VOLATILE_PATHS) ---
# Стенд поднят всю транзакцию и пишет логи сам: приёмка t8165 встала на 177 файлах
# storage/debugbar, ни одного исходника. Объявленное профилем не попадает в
# чувствительное множество вовсе; всё остальное ignored остаётся под наблюдением.
mkdir -p "$repo/ignored-logs"
printf 'ignored baseline\n' >"$repo/ignored-runtime"
export PROFILE_VOLATILE_PATHS="ignored-logs/*"
instrumentation_tx_begin 51 trace-volatile "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t51' "$repo"
assert_rc 0 "$?" "volatile-paths transaction starts"
assert_file_exists "$control_dir/transactions/t51/trace-volatile/volatile.list" \
  "begin freezes the profile globs next to roots.list"
printf 'стенд пишет лог сам\n' >"$repo/ignored-logs/app.log"
mkdir -p "$repo/ignored-logs/nested"
printf 'и во вложенный каталог тоже\n' >"$repo/ignored-logs/nested/trace.json"
instrumentation_tx_checkpoint 51 trace-volatile
assert_rc 0 "$?" "checkpoint ignores runtime junk declared volatile by the profile"
instrumentation_tx_cleanup 51 trace-volatile
assert_rc 0 "$?" "cleanup completes with volatile junk present"
assert_file_exists "$repo/ignored-logs/app.log" \
  "cleanup never deletes what the application wrote"

# Глоб покрывает ровно объявленное: соседний ignored-файл по-прежнему валит приёмку.
instrumentation_tx_begin 52 trace-volatile-narrow "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t52' "$repo"
assert_rc 0 "$?" "narrow-glob transaction starts"
printf 'правка мимо глоба\n' >"$repo/ignored-runtime"
instrumentation_tx_checkpoint 52 trace-volatile-narrow
assert_rc 75 "$?" "a volatile glob does not blind the guard to other ignored files"

# Scope сильнее глоба: заявленный файл остаётся под наблюдением и восстанавливается,
# даже если подходит под изменчивый путь.
printf 'ignored baseline\n' >"$repo/ignored-runtime"
printf 'scope baseline\n' >"$repo/ignored-logs/scoped.txt"
printf '%s\n' "$repo/ignored-logs/scoped.txt" >"$TEST_ROOT/volatile-scope.list"
instrumentation_tx_begin 53 trace-volatile-scope "$TEST_ROOT/volatile-scope.list" \
  'FACTORY-TRACE:t53' "$repo"
assert_rc 0 "$?" "scope-over-glob transaction starts"
printf 'правка этапа\n' >"$repo/ignored-logs/scoped.txt"
instrumentation_tx_checkpoint 53 trace-volatile-scope
assert_rc 0 "$?" "checkpoint accepts a scoped change under a volatile glob"
instrumentation_tx_cleanup 53 trace-volatile-scope
assert_rc 0 "$?" "cleanup completes for a scoped file under a volatile glob"
assert_eq "scope baseline" "$(cat "$repo/ignored-logs/scoped.txt")" \
  "scope beats the glob: the declared file is still restored"

# Абсолютный путь в списке — ошибка профиля, а не «глоб пошире»: он не относится
# ни к одному корню и молча не совпал бы ни с чем.
PROFILE_VOLATILE_PATHS="/etc/*"
instrumentation_tx_begin 54 trace-volatile-abs "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t54' "$repo"
assert_rc 78 "$?" "an absolute volatile path is refused at begin"

# Список заморожен: правка профиля между заходами не должна разводить снимки
# ОДНОЙ транзакции — иначе перезапуск демона выдал бы ложное нарушение readonly.
PROFILE_VOLATILE_PATHS="ignored-logs/*"
instrumentation_tx_begin 55 trace-volatile-frozen "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t55' "$repo"
assert_rc 0 "$?" "frozen-list transaction starts"
PROFILE_VOLATILE_PATHS="ignored-nothing/*"
printf 'лог после правки профиля\n' >"$repo/ignored-logs/app.log"
instrumentation_tx_checkpoint 55 trace-volatile-frozen
assert_rc 0 "$?" "checkpoint reads the frozen list, not the edited profile"

# Транзакция, начатая до появления механизма, читается как «изменчивых путей нет».
PROFILE_VOLATILE_PATHS="ignored-logs/*"
instrumentation_tx_begin 56 trace-volatile-legacy "$TEST_ROOT/marker.scope" \
  'FACTORY-TRACE:t56' "$repo"
assert_rc 0 "$?" "legacy-shape transaction starts"
rm -f "$control_dir/transactions/t56/trace-volatile-legacy/volatile.list"
printf 'лог без замороженного списка\n' >"$repo/ignored-logs/app.log"
instrumentation_tx_checkpoint 56 trace-volatile-legacy
assert_rc 75 "$?" "a transaction without volatile.list keeps the old strict behaviour"
unset PROFILE_VOLATILE_PATHS

finish_tests
