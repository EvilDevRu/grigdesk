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
dispatch_v1=00000000-0000-4000-8000-000000000001

# protocol root мог появиться раньше ledger через orchestrator/shared locks под umask 0002.
# Prepare обязан безопасно сузить уже существующие owned canonical directories.
mkdir -p "$control_dir/protocol-v2/tasks"
chmod 775 "$control_dir/protocol-v2" "$control_dir/protocol-v2/tasks"
assert_eq 775 "$(stat -c '%a' "$control_dir/protocol-v2")" \
  "fixture starts with a group-writable protocol root"

ATTEMPT_STATE_ID_OVERRIDE=a_11111111111111111111111111111111
attempt_v1=$(attempt_state_begin_v2 \
  42 demo-profile "$routes_dir" "$catalog_v1" "$dispatch_v1" alpha)
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
assert_eq 2 "$(_attempt_state_json get "$attempt_dir/attempt.json" schema)" \
  "new attempt metadata uses the versioned launch identity schema"
assert_eq "$catalog_v1" "$(_attempt_state_json get "$attempt_dir/attempt.json" catalogHash)" \
  "attempt metadata pins the verified current catalog"
assert_eq "$dispatch_v1" \
  "$(_attempt_state_json get "$attempt_dir/attempt.json" queueDispatchId)" \
  "attempt metadata pins the exact queue dispatch identity"
assert_eq alpha \
  "$(_attempt_state_json get "$attempt_dir/attempt.json" runnerPrimaryOverride)" \
  "attempt metadata distinguishes the exact runner override"

strict_v2="$TEST_ROOT/attempt-v2-missing-identity.json"
python3 - "$attempt_dir/attempt.json" "$strict_v2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
del value["runnerPrimaryOverride"]
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
    target.write("\n")
PY
_attempt_state_json validate-attempt "$strict_v2" 42 "$attempt_v1" >/dev/null 2>&1
assert_rc 78 "$?" "attempt schema 2 refuses a missing identity field"

strict_v2_runner="$TEST_ROOT/attempt-v2-long-runner.json"
python3 - "$attempt_dir/attempt.json" "$strict_v2_runner" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
value["runnerPrimaryOverride"] = "a" * 65
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
    target.write("\n")
PY
_attempt_state_json validate-attempt "$strict_v2_runner" 42 "$attempt_v1" >/dev/null 2>&1
assert_rc 78 "$?" "attempt schema 2 bounds runner override to 64 characters"

strict_v2_dispatch="$TEST_ROOT/attempt-v2-uppercase-dispatch.json"
python3 - "$attempt_dir/attempt.json" "$strict_v2_dispatch" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
value["queueDispatchId"] = "00000000-0000-4000-8000-00000000000A"
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
    target.write("\n")
PY
_attempt_state_json validate-attempt "$strict_v2_dispatch" 42 "$attempt_v1" \
  >/dev/null 2>&1
assert_rc 78 "$?" "attempt schema 2 rejects uppercase dispatch UUID"

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

# Если между fast check и authoritative begin исчез именно canonical current,
# valid expected получает typed mismatch с `none`. Повреждённый существующий
# pointer остаётся integrity failure: его нельзя безопасно переименовать в CAS.
current_pointer="$routes_dir/demo-profile/catalog/current.json"
current_saved="$TEST_ROOT/current.saved.json"
mv -- "$current_pointer" "$current_saved"
ATTEMPT_STATE_ID_OVERRIDE=a_52525252525252525252525252525252
current_missing=$(attempt_state_begin_v2 \
  52 demo-profile "$routes_dir" "$catalog_v2" "$dispatch_v1" alpha 2>&1)
current_missing_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
mv -- "$current_saved" "$current_pointer"
assert_rc 75 "$current_missing_rc" \
  "missing current after fast check is a typed catalog transition"
assert_contains "$current_missing" \
  "FACTORY_ERROR=catalog_changed EXPECTED=$catalog_v2 ACTUAL=none" \
  "missing current exposes the stable none marker"
current_missing_root=$(attempt_state_v2_task_root 52)
assert_file_missing "$current_missing_root/active-attempt.json" \
  "missing current publishes no active pointer"
assert_eq 0 \
  "$(find "$current_missing_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' | wc -l | tr -d ' ')" \
  "missing current publishes no attempt or pins"

mv -- "$current_pointer" "$current_saved"
printf '%s\n' '{"schema":2' >"$current_pointer"
ATTEMPT_STATE_ID_OVERRIDE=a_53535353535353535353535353535353
current_corrupt=$(attempt_state_begin_v2 \
  53 demo-profile "$routes_dir" "$catalog_v2" "$dispatch_v1" alpha 2>&1)
current_corrupt_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
rm -- "$current_pointer"
mv -- "$current_saved" "$current_pointer"
assert_rc 78 "$current_corrupt_rc" \
  "corrupt current remains a fail-closed integrity error"
case "$current_corrupt" in
  *FACTORY_ERROR=catalog_changed*)
    test_fail "corrupt current is not masked as a safe catalog mismatch" \
      "$current_corrupt"
    ;;
  *)
    test_ok "corrupt current is not masked as a safe catalog mismatch"
    ;;
esac
current_corrupt_root=$(attempt_state_v2_task_root 53)
assert_file_missing "$current_corrupt_root/active-attempt.json" \
  "corrupt current publishes no active pointer"
assert_eq 0 \
  "$(find "$current_corrupt_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' | wc -l | tr -d ' ')" \
  "corrupt current publishes no attempt or pins"

# Ранний check мог увидеть catalog v1, но authoritative begin обязан заново
# сравнить current под task lock. Mismatch не публикует ни attempt, ни pins/pointer.
ATTEMPT_STATE_ID_OVERRIDE=a_47474747474747474747474747474747
catalog_changed=$(attempt_state_begin_v2 \
  47 demo-profile "$routes_dir" "$catalog_v1" "$dispatch_v1" alpha 2>&1 >/dev/null)
catalog_changed_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 75 "$catalog_changed_rc" "authoritative begin rejects a stale expected catalog"
assert_contains "$catalog_changed" \
  "FACTORY_ERROR=catalog_changed EXPECTED=$catalog_v1 ACTUAL=$catalog_v2" \
  "catalog CAS failure has a stable machine-readable marker"
catalog_changed_root=$(attempt_state_v2_task_root 47)
assert_file_missing "$catalog_changed_root/active-attempt.json" \
  "catalog CAS mismatch publishes no active pointer"
assert_eq 0 \
  "$(find "$catalog_changed_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' | wc -l | tr -d ' ')" \
  "catalog CAS mismatch publishes no attempt or pins"

# expected hash без dispatch — штатный manual launch; guard однонаправленный.
ATTEMPT_STATE_ID_OVERRIDE=a_48484848484848484848484848484848
manual_expected=$(attempt_state_begin_v2 48 demo-profile "$routes_dir" "$catalog_v2")
manual_expected_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$manual_expected_rc" "manual begin may pin an expected catalog without dispatch"
manual_expected_dir="$(attempt_state_v2_task_root 48)/attempts/$manual_expected"
assert_eq null "$(json_field "$(cat "$manual_expected_dir/attempt.json")" queueDispatchId)" \
  "manual expected launch records nullable queue provenance"
assert_eq "" "$(_attempt_state_json get "$manual_expected_dir/attempt.json" runnerPrimaryOverride)" \
  "empty runner override remains an exact empty string"
attempt_state_abandon_v2 48 "$manual_expected" 'manual expected fixture завершён' >/dev/null
assert_rc 0 "$?" "manual expected attempt remains normally closable"

attempt_state_begin_v2 49 demo-profile "$routes_dir" "" "$dispatch_v1" alpha \
  >/dev/null 2>&1
assert_rc 2 "$?" "dispatch without expected catalog is refused before state mutation"
attempt_state_begin_v2 49 demo-profile "$routes_dir" invalid "" alpha \
  >/dev/null 2>&1
assert_rc 2 "$?" "invalid expected catalog is refused before state mutation"
attempt_state_begin_v2 49 demo-profile "$routes_dir" "$catalog_v2" \
  not-a-uuid alpha >/dev/null 2>&1
assert_rc 2 "$?" "invalid dispatch UUID is refused before state mutation"
uppercase_dispatch=00000000-0000-4000-8000-00000000000A
attempt_state_begin_v2 49 demo-profile "$routes_dir" "$catalog_v2" \
  "$uppercase_dispatch" alpha >/dev/null 2>&1
assert_rc 2 "$?" "uppercase dispatch UUID is refused before state mutation"
runner_too_long=$(printf 'a%.0s' {1..65})
attempt_state_begin_v2 49 demo-profile "$routes_dir" "$catalog_v2" \
  "" "$runner_too_long" >/dev/null 2>&1
assert_rc 2 "$?" "runner override over 64 characters is refused before state mutation"
assert_file_missing "$control_dir/protocol-v2/tasks/t49" \
  "invalid launch identity creates no task ledger"

# Recovery — новый run: он сохраняет task-level runner policy, но dispatch ID
# остаётся уникальным для предшественницы и не может принадлежать двум attempts.
ATTEMPT_STATE_ID_OVERRIDE=a_50505050505050505050505050505050
queued_predecessor=$(attempt_state_begin_v2 \
  50 demo-profile "$routes_dir" "$catalog_v2" "$dispatch_v1" alpha)
unset ATTEMPT_STATE_ID_OVERRIDE
attempt_state_select_route_v2 50 "$queued_predecessor" debug >/dev/null
attempt_state_abandon_v2 50 "$queued_predecessor" 'queue fixture recovery' >/dev/null
ATTEMPT_STATE_ID_OVERRIDE=a_51515151515151515151515151515151
queued_recovery=$(attempt_state_recover_v2 \
  50 "$queued_predecessor" 'отдельный recovery' beta)
queued_recovery_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$queued_recovery_rc" "schema 2 queue attempt can recover as a separate run"
queued_root=$(attempt_state_v2_task_root 50)
assert_eq "$dispatch_v1" \
  "$(_attempt_state_json get "$queued_root/attempts/$queued_predecessor/attempt.json" queueDispatchId)" \
  "predecessor retains its immutable dispatch identity"
assert_eq "" \
  "$(_attempt_state_json get "$queued_root/attempts/$queued_recovery/attempt.json" queueDispatchId)" \
  "recovery does not create a second owner of the dispatch identity"
assert_eq alpha \
  "$(_attempt_state_json get "$queued_root/attempts/$queued_recovery/attempt.json" runnerPrimaryOverride)" \
  "schema 2 recovery trusts the predecessor runner override, not a fallback"
strict_recovery="$TEST_ROOT/recovery-v2-with-dispatch.json"
python3 - \
  "$queued_root/attempts/$queued_recovery/attempt.json" "$strict_recovery" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
value["queueDispatchId"] = "00000000-0000-4000-8000-000000000009"
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
    target.write("\n")
PY
_attempt_state_json validate-attempt \
  "$strict_recovery" 50 "$queued_recovery" >/dev/null 2>&1
assert_rc 78 "$?" "schema 2 recovery rejects non-null dispatch provenance"
attempt_state_abandon_v2 50 "$queued_recovery" 'queue recovery fixture завершён' >/dev/null
assert_rc 0 "$?" "queue recovery attempt remains independently closable"

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

# Rolling upgrade: schema 1 был exact-документом без queue/runner полей. Reader
# обязан принять его как есть, а не требовать миграцию immutable attempt на месте.
chmod 600 "$abandoned_dir/attempt.json" "$abandoned_dir/attempt.sha256"
python3 - "$abandoned_dir/attempt.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    value = json.load(source)
value["schema"] = 1
del value["queueDispatchId"]
del value["runnerPrimaryOverride"]
with open(path, "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, indent=2)
    target.write("\n")
PY
sha256sum "$abandoned_dir/attempt.json" | awk '{print $1}' \
  >"$abandoned_dir/attempt.sha256"
chmod 400 "$abandoned_dir/attempt.json" "$abandoned_dir/attempt.sha256"
legacy_attempt_resume=$(attempt_state_resume_v2 42 "$abandoned")
assert_rc 0 "$?" "schema 1 attempt remains readable and resumable after upgrade"
assert_contains "$legacy_attempt_resume" "\"catalogHash\": \"$catalog_v2\"" \
  "schema 1 resume keeps its original catalog pin"
attempt_state_select_route_v2 42 "$abandoned" debug >/dev/null
assert_rc 0 "$?" "predecessor has its own route selection"

# Причина ручного вмешательства ограничена 20 000 символов, и отказ обязан называть
# нарушенное правило: молчащий код 2 неотличим от отказа ledger, и человек ищет
# причину в состоянии попытки, а не в своём тексте.
long_reason=$(python3 -c 'print("щ" * 20001, end="")')
long_stderr=$(attempt_state_abandon_v2 42 "$abandoned" "$long_reason" 2>&1 >/dev/null)
assert_rc 2 "$?" "abandon refuses a reason over the limit"
assert_contains "$long_stderr" 'причина 20001 символов, допустимо 1..20000' \
  "the refusal names the violated rule instead of a bare exit code"
assert_contains "$long_stderr" 'файл этапа' \
  "the refusal says where a long explanation belongs"
empty_stderr=$(_attempt_state_reason '' 2>&1 >/dev/null)
assert_rc 2 "$?" "an empty reason is refused"
assert_contains "$empty_stderr" 'не может быть пустой' \
  "the empty reason refusal is named too"
# Указание человека — это текст задания следующему агенту: перечень точек правки,
# таблица замеров, запреты. Однострочный лимит резал его на первом абзаце, поэтому
# многострочность разрешена, а из управляющих символов запрещено всё остальное.
_attempt_state_reason 'первая строка
вторая строка'
assert_rc 0 "$?" "a multi-line reason is accepted"
control_stderr=$(_attempt_state_reason "$(printf 'первая строка\rвторая')" 2>&1 >/dev/null)
assert_rc 2 "$?" "a carriage return is still refused"
assert_contains "$control_stderr" 'возврат каретки в позиции 14' \
  "the refusal points at the offending character"
# Лимит считается в символах, а не в байтах: 20 000 кириллических — это 40 000 байт,
# и граница обязана пропускать их, иначе русский текст обрезается вдвое.
boundary_reason=$(python3 -c 'print("щ" * 20000, end="")')
_attempt_state_reason "$boundary_reason"
assert_rc 0 "$?" "a reason of exactly 20000 characters is accepted"
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
recovery=$(attempt_state_recover_v2 \
  42 "$abandoned" 'продолжить от принятой границы' alpha)
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
assert_eq 2 "$(_attempt_state_json get "$recovery_dir/attempt.json" schema)" \
  "recovery from schema 1 writes the new strict schema 2"
assert_eq "" "$(_attempt_state_json get "$recovery_dir/attempt.json" queueDispatchId)" \
  "recovery never inherits queue provenance"
assert_eq alpha \
  "$(_attempt_state_json get "$recovery_dir/attempt.json" runnerPrimaryOverride)" \
  "schema 1 recovery receives the exact legacy registry runner fallback"
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
