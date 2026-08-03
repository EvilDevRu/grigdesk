#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-state.sh"
control_dir=$(factory_control_root)

publisher="$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs"
routes_dir="$TEST_ROOT/routes"

json_field() {
  "$NODE_BIN" -e \
    'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value[process.argv[2]]));' \
    "$1" "$2"
}

if [[ -z "${NODE_BIN:-}" || ! -x "$NODE_BIN" ]]; then
  test_fail "host node is available" "NODE_BIN is empty"
  finish_tests
  exit $?
fi

# Старое состояние v1 существует рядом, но v2 его не открывает и не переписывает.
printf 'PROFILE=legacy\nSCOUT_STATUS=done\n' >"$STATE_DIR/t42.pipeline"
legacy_before=$(sha256sum "$STATE_DIR/t42.pipeline" | awk '{print $1}')

first=$("$NODE_BIN" "$publisher" "$routes_dir" 'Диагностика v1' null)
assert_rc 0 "$?" "immutable route fixture is published"
catalog_v1=$(json_field "$first" catalogHash)
route_v1=$(json_field "$first" routeHash)

# protocol root мог появиться раньше ledger через orchestrator/shared locks под umask 0002.
# Prepare обязан безопасно сузить уже существующие owned canonical directories.
mkdir -p "$control_dir/protocol-v2/tasks"
chmod 775 "$control_dir/protocol-v2" "$control_dir/protocol-v2/tasks"
assert_eq 775 "$(stat -c '%a' "$control_dir/protocol-v2")" \
  "fixture starts with a group-writable protocol root"

ATTEMPT_STATE_ID_OVERRIDE=a_11111111111111111111111111111111
attempt_v1=$(attempt_state_begin_v2 42 demo-profile "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "v2 bootstrap attempt starts"
assert_eq a_11111111111111111111111111111111 "$attempt_v1" \
  "attempt identity is explicit and stable"

task_root=$(attempt_state_v2_task_root 42)
attempt_dir="$task_root/attempts/$attempt_v1"
assert_eq 700 "$(stat -c '%a' "$control_dir/protocol-v2")" \
  "attempt prepare narrows an existing protocol root to owner-only"
assert_eq 700 "$(stat -c '%a' "$control_dir/protocol-v2/tasks")" \
  "attempt prepare narrows an existing tasks root to owner-only"
assert_eq 700 "$(stat -c '%a' "$task_root")" \
  "task ledger root is owner-only"
assert_eq 700 "$(stat -c '%a' "$task_root/attempts")" \
  "attempts directory is owner-only"
assert_file_exists "$attempt_dir/attempt.json" \
  "attempt metadata is published in the isolated v2 namespace"
assert_file_exists "$attempt_dir/pins.json" \
  "catalog and bootstrap pins are published with the attempt"
assert_file_exists "$task_root/active-attempt.json" \
  "active attempt pointer is published atomically"
assert_eq 400 "$(stat -c '%a' "$attempt_dir/attempt.json")" \
  "immutable attempt metadata is read-only"
assert_eq 2 "$(_attempt_state_json get "$attempt_dir/attempt.json" protocolVersion)" \
  "attempt metadata records protocolVersion"
assert_eq "$catalog_v1" "$(_attempt_state_json get "$attempt_dir/attempt.json" catalogHash)" \
  "attempt metadata pins the verified current catalog"

metadata_before=$(sha256sum "$attempt_dir/attempt.json" | awk '{print $1}')
pins_before=$(sha256sum "$attempt_dir/pins.json" | awk '{print $1}')
bootstrap_resume=$(attempt_state_resume_v2 42 "$attempt_v1")
assert_rc 0 "$?" "resume before route selection succeeds"
assert_contains "$bootstrap_resume" "\"catalogHash\": \"$catalog_v1\"" \
  "resume before selection keeps the original catalog pin"
assert_contains "$bootstrap_resume" "\"route\": null" \
  "new attempt remains in bootstrap until one-time selection"

second=$("$NODE_BIN" "$publisher" "$routes_dir" 'Диагностика v2' "$catalog_v1")
assert_rc 0 "$?" "a new current catalog is published while Scout is running"
catalog_v2=$(json_field "$second" catalogHash)
route_v2=$(json_field "$second" routeHash)

bootstrap_after_promotion=$(attempt_state_resume_v2 42 "$attempt_v1")
assert_rc 0 "$?" "bootstrap attempt resumes after current promotion"
assert_contains "$bootstrap_after_promotion" "\"catalogHash\": \"$catalog_v1\"" \
  "current promotion cannot silently re-pin an existing attempt"

selected_hash=$(attempt_state_select_route_v2 42 "$attempt_v1" debug)
assert_rc 0 "$?" "route is selected from the pinned catalog"
assert_eq "$route_v1" "$selected_hash" \
  "route hash comes from catalog v1 rather than the newer current"
route_pin=$(find "$attempt_dir" -maxdepth 1 -type f -name 'route-pin.*.json')
assert_file_exists "$route_pin" "one-time route selection is an immutable state file"
assert_eq 400 "$(stat -c '%a' "$route_pin")" \
  "route pin is read-only after atomic publication"

selected_resume=$(attempt_state_resume_v2 42 "$attempt_v1")
assert_rc 0 "$?" "resume after route selection succeeds"
assert_contains "$selected_resume" "\"hash\": \"$route_v1\"" \
  "resume keeps the selected route revision"
assert_contains "$selected_resume" "\"id\": \"debug\"" \
  "resume keeps the selected route id"

attempt_state_select_route_v2 42 "$attempt_v1" debug >/dev/null 2>&1
assert_rc 73 "$?" "route selection cannot be repeated even with the same id"
attempt_state_select_route_v2 42 "$attempt_v1" '../debug' >/dev/null 2>&1
assert_rc 2 "$?" "route path traversal is rejected before state access"
attempt_state_select_route_v2 42 a_99999999999999999999999999999999 debug \
  >/dev/null 2>&1
assert_rc 75 "$?" "stale attempt id loses the active-pointer CAS"

ATTEMPT_STATE_ID_OVERRIDE=a_99999999999999999999999999999999
attempt_state_begin_v2 42 demo-profile "$routes_dir" >/dev/null 2>&1
active_begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 73 "$active_begin_rc" "a second active attempt cannot be created"

attempt_state_finish_v2 42 "$attempt_v1" >/dev/null
assert_rc 0 "$?" "active attempt can be finished explicitly"
assert_file_missing "$task_root/active-attempt.json" \
  "finish removes only the matching active pointer"
terminal_v1=$(find "$attempt_dir" -maxdepth 1 -type f -name 'terminal.*.json')
assert_file_exists "$terminal_v1" "finish leaves immutable terminal metadata"
assert_eq finished "$(_attempt_state_json get "$terminal_v1" state)" \
  "terminal metadata distinguishes a normal finish"
assert_eq "$metadata_before" "$(sha256sum "$attempt_dir/attempt.json" | awk '{print $1}')" \
  "route selection and finish never rewrite attempt metadata"
assert_eq "$pins_before" "$(sha256sum "$attempt_dir/pins.json" | awk '{print $1}')" \
  "two-phase selection never rewrites catalog/bootstrap pins"
_attempt_state_json make-active "$attempt_v1" 42 >"$task_root/active-attempt.json"
chmod 400 "$task_root/active-attempt.json"
attempt_state_finish_v2 42 "$attempt_v1" >/dev/null
assert_rc 0 "$?" "finish repairs a crash after durable terminal publication"
assert_file_missing "$task_root/active-attempt.json" \
  "terminal repair removes the stale matching active pointer"
attempt_state_resume_v2 42 "$attempt_v1" >/dev/null 2>&1
assert_rc 75 "$?" "finished attempt is not silently resumed as active"

# Следующая попытка видит новый current, но остаётся отдельным состоянием.
ATTEMPT_STATE_ID_OVERRIDE=a_22222222222222222222222222222222
attempt_v2=$(attempt_state_begin_v2 42 demo-profile "$routes_dir")
second_begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$second_begin_rc" "new attempt starts after the previous finish"
attempt_v2_dir="$task_root/attempts/$attempt_v2"
assert_eq "$catalog_v2" "$(_attempt_state_json get "$attempt_v2_dir/attempt.json" catalogHash)" \
  "only a new attempt observes the promoted catalog"
attempt_state_finish_v2 42 "$attempt_v2" >/dev/null 2>&1
assert_rc 73 "$?" "bootstrap attempt cannot finish before route selection"
assert_file_exists "$task_root/active-attempt.json" \
  "rejected premature finish preserves the active pointer"
selected_v2=$(attempt_state_select_route_v2 42 "$attempt_v2" debug)
assert_rc 0 "$?" "second attempt selects its route before finish"
assert_eq "$route_v2" "$selected_v2" \
  "route selection resolves inside the catalog pinned by the attempt"
attempt_state_finish_v2 42 "$attempt_v2" >/dev/null
assert_rc 0 "$?" "second attempt finishes"
ATTEMPT_STATE_ID_OVERRIDE=a_99999999999999999999999999999999
attempt_state_recover_v2 42 "$attempt_v2" 'нельзя восстанавливать finished' >/dev/null 2>&1
recover_finished_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 75 "$recover_finished_rc" "recovery requires an explicitly abandoned predecessor"

# Recovery создаёт новый bootstrap attempt и сохраняет происхождение, а не переиспользует каталог.
ATTEMPT_STATE_ID_OVERRIDE=a_33333333333333333333333333333333
abandoned=$(attempt_state_begin_v2 42 demo-profile "$routes_dir")
abandoned_begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$abandoned_begin_rc" "attempt for recovery scenario starts"
abandoned_dir="$task_root/attempts/$abandoned"
attempt_state_select_route_v2 42 "$abandoned" debug >/dev/null
assert_rc 0 "$?" "predecessor has its own route selection"

# Причина ручного вмешательства ограничена одной строкой в 500 символов, и отказ
# обязан называть нарушенное правило: молчащий код 2 неотличим от отказа ledger,
# и человек ищет причину в состоянии попытки, а не в своём тексте.
long_reason=$(python3 -c 'print("щ" * 501, end="")')
long_stderr=$(attempt_state_abandon_v2 42 "$abandoned" "$long_reason" 2>&1 >/dev/null)
assert_rc 2 "$?" "abandon refuses a reason over the limit"
assert_contains "$long_stderr" 'причина 501 символов, допустимо 1..500' \
  "the refusal names the violated rule instead of a bare exit code"
assert_contains "$long_stderr" 'файл этапа' \
  "the refusal says where a long explanation belongs"
empty_stderr=$(_attempt_state_reason '' 2>&1 >/dev/null)
assert_rc 2 "$?" "an empty reason is refused"
assert_contains "$empty_stderr" 'не может быть пустой' \
  "the empty reason refusal is named too"
multiline_stderr=$(_attempt_state_reason 'первая строка
вторая строка' 2>&1 >/dev/null)
assert_rc 2 "$?" "a multi-line reason is refused"
assert_contains "$multiline_stderr" 'перевод строки в позиции 14' \
  "the refusal points at the offending character"
# Лимит считается в символах, а не в байтах: 500 кириллических — это 1000 байт,
# и граница обязана пропускать их, иначе русская причина обрезается вдвое.
boundary_reason=$(python3 -c 'print("щ" * 500, end="")')
_attempt_state_reason "$boundary_reason"
assert_rc 0 "$?" "a reason of exactly 500 characters is accepted"
assert_eq 0 \
  "$(find "$abandoned_dir" -maxdepth 1 -type f -name 'terminal.*.json' | wc -l | tr -d ' ')" \
  "a refused reason closes nothing"

attempt_state_abandon_v2 42 "$abandoned" 'оператор остановил попытку' >/dev/null
assert_rc 0 "$?" "attempt is explicitly abandoned"
abandoned_terminal=$(find "$abandoned_dir" -maxdepth 1 -type f -name 'terminal.*.json')
assert_eq abandoned "$(_attempt_state_json get "$abandoned_terminal" state)" \
  "terminal metadata distinguishes abandon"

third=$("$NODE_BIN" "$publisher" "$routes_dir" 'Диагностика v3' "$catalog_v2")
assert_rc 0 "$?" "another catalog can be promoted before recovery"
catalog_v3=$(json_field "$third" catalogHash)

ATTEMPT_STATE_ID_OVERRIDE=a_44444444444444444444444444444444
recovery=$(attempt_state_recover_v2 42 "$abandoned" 'продолжить от принятой границы')
recovery_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$recovery_rc" "recovery creates a separate active attempt"
recovery_dir="$task_root/attempts/$recovery"
assert_eq "$abandoned" \
  "$(_attempt_state_json get "$recovery_dir/attempt.json" previousAttemptId)" \
  "recovery metadata links to the previous attempt id"
assert_eq recovery "$(_attempt_state_json get "$recovery_dir/attempt.json" origin)" \
  "recovery origin is explicit"
assert_eq "$catalog_v3" "$(_attempt_state_json get "$recovery_dir/attempt.json" catalogHash)" \
  "recovery performs a new explicit catalog pin"
recovery_resume=$(attempt_state_resume_v2 42 "$recovery")
assert_contains "$recovery_resume" "\"route\": null" \
  "recovery gets separate bootstrap state rather than copied route state"
assert_file_exists "$abandoned_dir/pins.json" \
  "recovery preserves the predecessor state"
attempt_state_abandon_v2 42 "$recovery" 'тест завершён' >/dev/null
assert_rc 0 "$?" "recovery attempt can be abandoned independently"

# Выходы этапов предшественницы не должны достаться новой попытке: CLI отказывается
# перезаписывать непрочитанный файл, и агент либо принимает чужой артефакт за свой,
# либо дописывает к нему свой.
printf 'разведка прошлой попытки\n' >"$STATE_DIR/t42.recon.md"
printf 'FE_PORT=5192\n' >"$STATE_DIR/t42.env"
printf 'лог оркестратора\n' >"$STATE_DIR/t42.orch.log"
ln -s "$STATE_DIR/t42.recon.md" "$STATE_DIR/t42.link.md"
quarantined=$(attempt_state_quarantine_artifacts_v2 42 "$abandoned" "$STATE_DIR")
assert_rc 0 "$?" "predecessor artifacts are quarantined on recovery"
assert_contains "$quarantined" "t42.recon.md" \
  "quarantine reports every moved artifact by name"
assert_file_missing "$STATE_DIR/t42.recon.md" \
  "stage artifact no longer lies in the task namespace"
assert_file_exists "$abandoned_dir/state-artifacts/t42.recon.md" \
  "stage artifact is recoverable from the predecessor archive"
assert_file_exists "$STATE_DIR/t42.env" \
  "engine-owned sandbox env stays where the engine expects it"
assert_file_exists "$STATE_DIR/t42.orch.log" \
  "engine-owned orchestrator log stays in place"
if [[ -L "$STATE_DIR/t42.link.md" ]]; then
  test_ok "a symlink in the task namespace is never followed or moved"
else
  test_fail "a symlink in the task namespace is never followed or moved" \
    "symlink is gone: $STATE_DIR/t42.link.md"
fi
attempt_state_quarantine_artifacts_v2 42 "$abandoned" "$TEST_ROOT/нет-такого" >/dev/null 2>&1
assert_rc 2 "$?" "quarantine fails closed on an unusable state dir"
rm -f "$STATE_DIR/t42.link.md" "$STATE_DIR/t42.env" "$STATE_DIR/t42.orch.log"

legacy_after=$(sha256sum "$STATE_DIR/t42.pipeline" | awk '{print $1}')
assert_eq "$legacy_before" "$legacy_after" \
  "all v2 operations leave the v1 pipeline byte-for-byte untouched"

# Повреждения и недопустимые пути приводят к закрытому отказу.
ATTEMPT_STATE_ID_OVERRIDE=a_55555555555555555555555555555555
tampered=$(attempt_state_begin_v2 43 demo-profile "$routes_dir")
tampered_begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$tampered_begin_rc" "tamper scenario starts"
tampered_root=$(attempt_state_v2_task_root 43)
tampered_dir="$tampered_root/attempts/$tampered"
chmod 600 "$tampered_dir/pins.json"
printf '{"schema":1}\n' >"$tampered_dir/pins.json"
attempt_state_resume_v2 43 "$tampered" >/dev/null 2>&1
assert_rc 78 "$?" "catalog pin tampering fails closed instead of taking current"
assert_file_exists "$tampered_root/active-attempt.json" \
  "failed resume does not mutate the active pointer"

bad_root="$control_dir/protocol-v2/tasks/t44"
mkdir -p "$bad_root/attempts"
printf '{"protocolVersion":1,"schema":1}\n' >"$bad_root/protocol.json"
ATTEMPT_STATE_ID_OVERRIDE=a_66666666666666666666666666666666
attempt_state_begin_v2 44 demo-profile "$routes_dir" >/dev/null 2>&1
bad_protocol_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 78 "$bad_protocol_rc" "v2 refuses a state root marked as protocol v1"

ln -s "$routes_dir" "$TEST_ROOT/routes-link"
attempt_state_begin_v2 45 demo-profile "$TEST_ROOT/routes-link" >/dev/null 2>&1
assert_rc 2 "$?" "ambiguous symlink routes path is rejected"
attempt_state_begin_v2 '../45' demo-profile "$routes_dir" >/dev/null 2>&1
assert_rc 2 "$?" "task path traversal is rejected"
attempt_state_begin_v2 45 '../profile' "$routes_dir" >/dev/null 2>&1
assert_rc 2 "$?" "profile path traversal is rejected"

# Два конкурентных begin сериализуются task-level flock: публикуется ровно один pointer.
(
  ATTEMPT_STATE_ID_OVERRIDE=a_77777777777777777777777777777777
  attempt_state_begin_v2 46 demo-profile "$routes_dir" >"$TEST_ROOT/race-a.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/race-a.rc"
) &
race_a_pid=$!
(
  ATTEMPT_STATE_ID_OVERRIDE=a_88888888888888888888888888888888
  attempt_state_begin_v2 46 demo-profile "$routes_dir" >"$TEST_ROOT/race-b.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/race-b.rc"
) &
race_b_pid=$!
wait "$race_a_pid"
wait "$race_b_pid"
race_codes=$(sort -n "$TEST_ROOT/race-a.rc" "$TEST_ROOT/race-b.rc" | paste -sd, -)
assert_eq 0,73 "$race_codes" "concurrent begin has one winner and one active-state conflict"
race_root=$(attempt_state_v2_task_root 46)
race_attempts=$(find "$race_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' |
  wc -l)
assert_eq 1 "$race_attempts" "losing begin never publishes a second attempt directory"
race_active=$(_attempt_state_json get "$race_root/active-attempt.json" attemptId)
attempt_state_abandon_v2 46 "$race_active" 'race test завершён' >/dev/null
assert_rc 0 "$?" "race winner remains a valid closable attempt"

if [[ "$catalog_v1" == "$catalog_v2" || "$catalog_v2" == "$catalog_v3" ||
      "$route_v1" == "$route_v2" ]]; then
  test_fail "fixture revisions differ" "catalog or route hashes unexpectedly match"
else
  test_ok "fixture revisions differ"
fi

finish_tests
