#!/usr/bin/env bash
# Проверяет CAS-хранилище цепочки возобновления провайдера: резервирование, продвижение,
# отмену, блокировку и устойчивость публикации после сбоев.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/provider-lineage-state.sh"

fixture="$FACTORY_TESTS_HOME/../fixtures/analytics/provider-lineage-vectors.json"
schema="$FACTORY_HOME/../schemas/analytics/provider-lineage.schema.json"
provider=codex
thread='00000000-0000-4000-8000-000000000001'

json_value() {
  local file=$1 expression=$2
  python3 - "$file" "$expression" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
for part in sys.argv[2].split("."):
    if part:
        value = value[int(part)] if isinstance(value, list) else value[part]
if value is None:
    print("null")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

request_from_fixture() {
  local key=$1 output=$2 scope=${3:-$thread}
  python3 - "$fixture" "$key" "$output" "$scope" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)[sys.argv[2]]
value["threadId"] = sys.argv[4]
with open(sys.argv[3], "w", encoding="utf-8", newline="") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    target.write("\n")
PY
}

mutate_request() {
  local input=$1 output=$2
  shift 2
  python3 - "$input" "$output" "$@" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
for mutation in sys.argv[3:]:
    path, encoded = mutation.split("=", 1)
    parts = path.split(".")
    parent = value
    for part in parts[:-1]:
        parent = parent[part]
    if encoded == "__DELETE__":
        del parent[parts[-1]]
    else:
        parent[parts[-1]] = json.loads(encoded)
with open(sys.argv[2], "w", encoding="utf-8", newline="") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    target.write("\n")
PY
}

read_record() {
  local scope=$1 output=$2
  provider_lineage_read_v1 "$provider" "$scope" >"$output"
}

control=$(factory_control_root) || exit 1
mkdir -p -- "$control" || exit 1
chmod 700 -- "$control"
trace="$TEST_ROOT/provider-lineage.trace"
export PROVIDER_LINEAGE_TRACE_FILE=$trace

# Сырой scope треда хешируется из одного закреплённого канонического кортежа и никогда
# не становится частью пути.
scope_canonical=$(provider_lineage_scope_canonical_v1 "$provider" "$thread")
assert_rc 0 "$?" "scope tuple canonicalizes"
assert_eq "$(json_value "$fixture" canonicalScope)" "$scope_canonical" \
  "shell producer and Node fixture share canonical scope bytes"
scope_hash=$(provider_lineage_scope_hash_v1 "$provider" "$thread")
assert_rc 0 "$?" "scope hash is derived without filesystem state"
assert_eq "$(json_value "$fixture" scopeSha256)" "$scope_hash" \
  "scope hash is pinned cross-language"

missing_thread='00000000-0000-4000-8000-000000000000'
provider_lineage_read_v1 "$provider" "$missing_thread" \
  >/dev/null 2>"$TEST_ROOT/missing.err"
assert_rc 3 "$?" "read of an absent lineage is non-mutating and named not-found"
if [[ ! -e "$control/protocol-v2" && ! -L "$control/protocol-v2" ]]; then
  test_ok "read does not create a lineage store as a side effect"
else
  test_fail "read does not create a lineage store as a side effect" "$control/protocol-v2"
fi

init="$TEST_ROOT/initialize.json"
request_from_fixture initializeRequest "$init"
noncanonical_init="$TEST_ROOT/initialize-noncanonical.json"
python3 - "$init" "$noncanonical_init" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
with open(sys.argv[2], "w", encoding="utf-8", newline="") as target:
    json.dump(value, target, ensure_ascii=False, indent=2)
    target.write("\n")
PY
provider_lineage_initialize_advanced_v1 "$noncanonical_init" \
  >/dev/null 2>"$TEST_ROOT/init-noncanonical.err"
assert_rc 78 "$?" "transition requests must use one bounded canonical JSON encoding"
partial_init="$TEST_ROOT/initialize-partial.json"
mutate_request "$init" "$partial_init" 'usageCompleteness="partial"'
provider_lineage_initialize_advanced_v1 "$partial_init" >/dev/null 2>"$TEST_ROOT/init-partial.err"
assert_rc 78 "$?" "fresh checkpoint must be complete before lineage initialization"

: >"$trace"
initial_out="$TEST_ROOT/initial-record.json"
provider_lineage_initialize_advanced_v1 "$init" >"$initial_out"
assert_rc 0 "$?" "fresh complete checkpoint initializes advanced generation zero"
assert_eq advanced "$(json_value "$initial_out" state)" "initial state is advanced"
assert_eq 0 "$(json_value "$initial_out" lineageGeneration)" "fresh checkpoint is generation zero"
assert_eq 1 "$(json_value "$initial_out" stateRevision)" "initial CAS revision is one"
assert_eq run-parent "$(json_value "$initial_out" predecessorRunId)" \
  "fresh run becomes the current predecessor checkpoint"
record=$(provider_lineage_record_path_v1 "$provider" "$thread")
assert_rc 0 "$?" "record path resolves from the scope hash"
assert_eq "$control/protocol-v2/provider-lineage/schema-1/codex/$scope_hash.json" "$record" \
  "raw threadId is absent from the record path"
assert_file_exists "$record" "advanced record is durable"
assert_eq 600 "$(stat -c '%a' "$record")" "lineage record is private"
for dir in \
  "$control/protocol-v2" \
  "$control/protocol-v2/provider-lineage" \
  "$control/protocol-v2/provider-lineage/schema-1" \
  "$control/protocol-v2/provider-lineage/schema-1/codex" \
  "$control/protocol-v2/provider-lineage/schema-1/codex/$scope_hash.lock"; do
  [[ -d "$dir" && ! -L "$dir" ]] \
    && test_ok "$(basename "$dir") is a real private store directory" \
    || test_fail "$(basename "$dir") is a real private store directory" "$dir"
  assert_eq 700 "$(stat -c '%a' "$dir")" "$(basename "$dir") is mode 0700"
done
if find "$control/protocol-v2/provider-lineage" -mindepth 1 -printf '%f\n' | grep -F "$thread" >/dev/null; then
  test_fail "raw provider scope never becomes a path component" "$thread"
else
  test_ok "raw provider scope never becomes a path component"
fi
initial_hash=$(python3 - "$record" <<'PY'
import hashlib
import sys
data = open(sys.argv[1], "rb").read()
assert data.endswith(b"\n") and not data.endswith(b"\n\n")
print(hashlib.sha256(data[:-1]).hexdigest())
PY
)
assert_eq "$(json_value "$fixture" initialRecordSha256)" "$initial_hash" \
  "initial canonical record matches the shared golden without LF"
assert_eq $'initialize:record_temp_fsync\ninitialize:record_rename\ninitialize:provider_directory_fsync' \
  "$(grep '^initialize:' "$trace")" "initial CAS uses the complete durability barrier"

before=$(sha256sum "$record" | awk '{print $1}')
provider_lineage_initialize_advanced_v1 "$init" >"$TEST_ROOT/init-retry.json"
assert_rc 0 "$?" "same initialization is idempotent"
assert_eq 1 "$(json_value "$TEST_ROOT/init-retry.json" stateRevision)" \
  "idempotent initialization does not increment revision"
assert_eq "$before" "$(sha256sum "$record" | awk '{print $1}')" \
  "idempotent initialization does not rewrite the record"
conflicting_init="$TEST_ROOT/init-conflict.json"
mutate_request "$init" "$conflicting_init" \
  'usageDocumentHash="9999999999999999999999999999999999999999999999999999999999999999"'
provider_lineage_initialize_advanced_v1 "$conflicting_init" >/dev/null 2>"$TEST_ROOT/init-conflict.err"
assert_rc 73 "$?" "different initialization payload conflicts"
assert_contains "$(cat "$TEST_ROOT/init-conflict.err")" provider-lineage-payload-conflict \
  "initialization conflict is named"

# Reserve закрепляет точный advanced checkpoint за одним потомком. Те же байты
# идемпотентны; другой потомок с той же ожидаемой ревизией проигрывает, не меняя победителя.
reserve="$TEST_ROOT/reserve.json"
request_from_fixture reserveRequest "$reserve"
mismatch="$TEST_ROOT/reserve-mismatch.json"
mutate_request "$reserve" "$mismatch" \
  'predecessorCheckpointHash="9999999999999999999999999999999999999999999999999999999999999999"'
provider_lineage_reserve_v1 "$mismatch" >/dev/null 2>"$TEST_ROOT/reserve-mismatch.err"
assert_rc 75 "$?" "reservation must pin the exact current checkpoint"

reserved_out="$TEST_ROOT/reserved.json"
provider_lineage_reserve_v1 "$reserve" >"$reserved_out"
assert_rc 0 "$?" "exact predecessor is reserved"
assert_eq reserved_before_start "$(json_value "$reserved_out" state)" \
  "reservation remains before launch barrier"
assert_eq 1 "$(json_value "$reserved_out" lineageGeneration)" \
  "advanced generation zero reserves generation one"
assert_eq 2 "$(json_value "$reserved_out" stateRevision)" \
  "reserve increments stateRevision"
provider_lineage_reserve_v1 "$reserve" >"$TEST_ROOT/reserve-retry.json"
assert_rc 0 "$?" "same reservation retry is idempotent"
assert_eq 2 "$(json_value "$TEST_ROOT/reserve-retry.json" stateRevision)" \
  "reservation retry does not increment revision"

loser="$TEST_ROOT/reserve-loser.json"
mutate_request "$reserve" "$loser" \
  'reservationId="lr_99999999999999999999999999999999"' \
  'childRunId="run-loser"'
provider_lineage_reserve_v1 "$loser" >/dev/null 2>"$TEST_ROOT/reserve-loser.err"
assert_rc 75 "$?" "second child cannot claim one predecessor"
assert_contains "$(cat "$TEST_ROOT/reserve-loser.err")" provider-lineage-scope-conflict \
  "competing child receives named scope conflict"
assert_eq run-child "$(json_value "$record" childRunId)" "winner remains authoritative"

# Для отмены нужны доказательства never-released и quiescence; она сохраняет поколение
# и разрешает только новое резервирование/потомка в том же поколении.
cancel="$TEST_ROOT/cancel.json"
request_from_fixture cancelRequest "$cancel"
bad_cancel="$TEST_ROOT/cancel-invalid.json"
mutate_request "$cancel" "$bad_cancel" 'cancellationProof.neverReleased=false'
provider_lineage_cancel_v1 "$bad_cancel" >/dev/null 2>"$TEST_ROOT/cancel-invalid.err"
assert_rc 78 "$?" "cancellation without never-released proof is rejected"
assert_eq reserved_before_start "$(json_value "$record" state)" \
  "invalid cancellation leaves reservation intact"

cancelled_out="$TEST_ROOT/cancelled.json"
provider_lineage_cancel_v1 "$cancel" >"$cancelled_out"
assert_rc 0 "$?" "never-released and quiesced child can be cancelled"
assert_eq cancelled_before_start "$(json_value "$cancelled_out" state)" \
  "safe cancellation is explicit"
assert_eq 1 "$(json_value "$cancelled_out" lineageGeneration)" \
  "cancel does not consume a generation"
assert_eq 3 "$(json_value "$cancelled_out" stateRevision)" \
  "cancel pins a new CAS revision"
provider_lineage_cancel_v1 "$cancel" >"$TEST_ROOT/cancel-retry.json"
assert_rc 0 "$?" "same cancellation retry is idempotent"

rereserve="$TEST_ROOT/rereserve.json"
mutate_request "$reserve" "$rereserve" \
  'expectedStateRevision=3' \
  'reservationId="lr_22222222222222222222222222222222"' \
  'childRunId="run-child-retry"'
provider_lineage_reserve_v1 "$rereserve" >"$TEST_ROOT/rereserved.json"
assert_rc 0 "$?" "cancelled generation accepts a new reservation"
assert_eq 1 "$(json_value "$TEST_ROOT/rereserved.json" lineageGeneration)" \
  "replacement reservation reuses only the unconsumed generation"
assert_eq 4 "$(json_value "$TEST_ROOT/rereserved.json" stateRevision)" \
  "replacement reservation increments revision"
provider_lineage_reserve_v1 "$reserve" >/dev/null 2>"$TEST_ROOT/old-reservation.err"
assert_rc 75 "$?" "cancelled reservation cannot be resurrected"

# Переход через started навсегда расходует предшественника. Cancel теперь не проходит;
# advance требует точный полный неизменяемый документ, подходящий checkpoint и lifecycle-хеши.
started="$TEST_ROOT/started-request.json"
request_from_fixture startedRequest "$started"
mutate_request "$started" "$started" \
  'expectedStateRevision=4' \
  'reservationId="lr_22222222222222222222222222222222"' \
  'childRunId="run-child-retry"'
provider_lineage_mark_started_v1 "$started" >"$TEST_ROOT/started.json"
assert_rc 0 "$?" "fsynced runner_started correlation marks lineage started"
assert_eq started "$(json_value "$TEST_ROOT/started.json" state)" "started is durable"
assert_eq 5 "$(json_value "$TEST_ROOT/started.json" stateRevision)" \
  "started increments revision"

cancel_after="$TEST_ROOT/cancel-after-start.json"
mutate_request "$cancel" "$cancel_after" \
  'expectedStateRevision=5' \
  'reservationId="lr_22222222222222222222222222222222"' \
  'childRunId="run-child-retry"'
provider_lineage_cancel_v1 "$cancel_after" >/dev/null 2>"$TEST_ROOT/cancel-after-start.err"
assert_rc 75 "$?" "started predecessor can never return to cancelled_before_start"
assert_contains "$(cat "$TEST_ROOT/cancel-after-start.err")" provider-lineage-predecessor-consumed \
  "post-start cancellation names predecessor consumption"

advance="$TEST_ROOT/advance-request.json"
request_from_fixture advanceRequest "$advance"
mutate_request "$advance" "$advance" \
  'expectedStateRevision=5' \
  'reservationId="lr_22222222222222222222222222222222"' \
  'childRunId="run-child-retry"'
partial_advance="$TEST_ROOT/advance-partial.json"
mutate_request "$advance" "$partial_advance" 'usageCompleteness="partial"'
provider_lineage_advance_v1 "$partial_advance" >/dev/null 2>"$TEST_ROOT/advance-partial.err"
assert_rc 78 "$?" "partial usage document cannot advance lineage"
ineligible_advance="$TEST_ROOT/advance-ineligible.json"
mutate_request "$advance" "$ineligible_advance" 'resumeEligible=false'
provider_lineage_advance_v1 "$ineligible_advance" >/dev/null 2>"$TEST_ROOT/advance-ineligible.err"
assert_rc 78 "$?" "ineligible checkpoint cannot advance lineage"
missing_lifecycle="$TEST_ROOT/advance-no-lifecycle.json"
mutate_request "$advance" "$missing_lifecycle" 'runnerUsageRecordedEventHash=__DELETE__'
provider_lineage_advance_v1 "$missing_lifecycle" >/dev/null 2>"$TEST_ROOT/advance-no-lifecycle.err"
assert_rc 78 "$?" "advance requires runner_usage_recorded lifecycle hash"
assert_eq started "$(json_value "$record" state)" "rejected advance keeps predecessor consumed"

advanced_out="$TEST_ROOT/advanced.json"
provider_lineage_advance_v1 "$advance" >"$advanced_out"
assert_rc 0 "$?" "complete immutable usage/checkpoint advances lineage"
assert_eq advanced "$(json_value "$advanced_out" state)" "child becomes current checkpoint"
assert_eq 6 "$(json_value "$advanced_out" stateRevision)" "advance increments revision"
assert_eq run-child-retry "$(json_value "$advanced_out" predecessorRunId)" \
  "successful child atomically replaces predecessor"
assert_eq "$(json_value "$advance" usageDocumentHash)" \
  "$(json_value "$advanced_out" predecessorUsageDocumentHash)" \
  "advanced checkpoint pins immutable usage document hash"
assert_eq "$(json_value "$advance" runnerUsageRecordedEventHash)" \
  "$(json_value "$advanced_out" predecessorRunnerUsageRecordedEventHash)" \
  "advanced checkpoint pins lifecycle usage event hash"
provider_lineage_advance_v1 "$advance" >"$TEST_ROOT/advance-retry.json"
assert_rc 0 "$?" "same advance retry is idempotent"
assert_eq 6 "$(json_value "$TEST_ROOT/advance-retry.json" stateRevision)" \
  "advance retry does not increment revision"

next_reserve="$TEST_ROOT/next-reserve.json"
mutate_request "$rereserve" "$next_reserve" \
  'expectedStateRevision=6' \
  'lineageGeneration=2' \
  'predecessorRunId="run-child-retry"' \
  'predecessorUsageDocumentHash="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"' \
  'predecessorCheckpointHash="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  'reservationId="lr_33333333333333333333333333333333"' \
  'childRunId="run-grandchild"'
reused_reservation="$TEST_ROOT/reused-reservation.json"
mutate_request "$next_reserve" "$reused_reservation" \
  'reservationId="lr_22222222222222222222222222222222"'
provider_lineage_reserve_v1 "$reused_reservation" \
  >/dev/null 2>"$TEST_ROOT/reused-reservation.err"
assert_rc 75 "$?" "a completed reservationId cannot be reused by a later generation"
provider_lineage_reserve_v1 "$next_reserve" >"$TEST_ROOT/next-reserved.json"
assert_rc 0 "$?" "next resume claims only the newly advanced checkpoint"
assert_eq 2 "$(json_value "$TEST_ROOT/next-reserved.json" lineageGeneration)" \
  "next resume advances lineage generation"
provider_lineage_reserve_v1 "$rereserve" >/dev/null 2>"$TEST_ROOT/reuse-old.err"
assert_rc 75 "$?" "old predecessor checkpoint is never reusable after started"

# Запущенное резервирование без полного checkpoint долговечно блокируется и не имеет
# автоматического выхода через reserve/advance.
block_thread='00000000-0000-4000-8000-000000000002'
block_init="$TEST_ROOT/block-init.json"
block_reserve="$TEST_ROOT/block-reserve.json"
block_started="$TEST_ROOT/block-started.json"
block_request="$TEST_ROOT/block-request.json"
request_from_fixture initializeRequest "$block_init" "$block_thread"
request_from_fixture reserveRequest "$block_reserve" "$block_thread"
request_from_fixture startedRequest "$block_started" "$block_thread"
request_from_fixture blockRequest "$block_request" "$block_thread"
provider_lineage_initialize_advanced_v1 "$block_init" >/dev/null
provider_lineage_reserve_v1 "$block_reserve" >/dev/null
provider_lineage_mark_started_v1 "$block_started" >/dev/null
provider_lineage_block_v1 "$block_request" >"$TEST_ROOT/blocked.json"
assert_rc 0 "$?" "started reservation can be blocked with bounded evidence"
assert_eq blocked_after_start "$(json_value "$TEST_ROOT/blocked.json" state)" \
  "missing complete usage consumes predecessor in blocked state"
assert_eq 4 "$(json_value "$TEST_ROOT/blocked.json" stateRevision)" \
  "block transition increments revision"
provider_lineage_block_v1 "$block_request" >"$TEST_ROOT/block-retry.json"
assert_rc 0 "$?" "same block retry is idempotent"
block_advance="$TEST_ROOT/block-advance.json"
request_from_fixture advanceRequest "$block_advance" "$block_thread"
provider_lineage_advance_v1 "$block_advance" >/dev/null 2>"$TEST_ROOT/block-advance.err"
assert_rc 75 "$?" "blocked lineage cannot advance automatically"
blocked_reserve="$TEST_ROOT/blocked-reserve.json"
mutate_request "$block_reserve" "$blocked_reserve" \
  'expectedStateRevision=4' \
  'lineageGeneration=2' \
  'reservationId="lr_77777777777777777777777777777777"' \
  'childRunId="run-after-block"'
provider_lineage_reserve_v1 "$blocked_reserve" >/dev/null 2>"$TEST_ROOT/blocked-reserve.err"
assert_rc 75 "$?" "blocked predecessor cannot be claimed again"

# Два настоящих писателя, соревнующиеся за один соседний scope-lock, выбирают ровно одного потомка.
race_thread='00000000-0000-4000-8000-000000000003'
race_init="$TEST_ROOT/race-init.json"
race_a="$TEST_ROOT/race-a.json"
race_b="$TEST_ROOT/race-b.json"
request_from_fixture initializeRequest "$race_init" "$race_thread"
request_from_fixture reserveRequest "$race_a" "$race_thread"
mutate_request "$race_a" "$race_b" \
  'reservationId="lr_88888888888888888888888888888888"' \
  'childRunId="run-race-b"'
provider_lineage_initialize_advanced_v1 "$race_init" >/dev/null
(provider_lineage_reserve_v1 "$race_a" >"$TEST_ROOT/race-a.out" 2>"$TEST_ROOT/race-a.err"; \
  printf '%s\n' "$?" >"$TEST_ROOT/race-a.rc") &
race_pid_a=$!
(provider_lineage_reserve_v1 "$race_b" >"$TEST_ROOT/race-b.out" 2>"$TEST_ROOT/race-b.err"; \
  printf '%s\n' "$?" >"$TEST_ROOT/race-b.rc") &
race_pid_b=$!
wait "$race_pid_a"; wait "$race_pid_b"
assert_eq $'0\n75' "$(cat "$TEST_ROOT/race-a.rc" "$TEST_ROOT/race-b.rc" | sort -n)" \
  "concurrent claim elects one winner and one scope conflict"
race_record="$TEST_ROOT/race-record.json"
read_record "$race_thread" "$race_record"
assert_rc 0 "$?" "winning concurrent record remains valid"
assert_eq 2 "$(json_value "$race_record" stateRevision)" \
  "concurrent writers produce one reserve transition"
race_child=$(json_value "$race_record" childRunId)
[[ "$race_child" == run-child || "$race_child" == run-race-b ]] \
  && test_ok "concurrent winner is one exact requested child" \
  || test_fail "concurrent winner is one exact requested child" "$race_child"

# Падение на любой границе публикации оставляет либо старую ревизию, либо идемпотентно
# повторяемую новую. Осиротевшие temp-файлы никогда не выбираются.
crash_steps=(
  reserve:record_temp_fsync
  reserve:record_rename
  reserve:provider_directory_fsync
)
for crash_index in "${!crash_steps[@]}"; do
  crash_step=${crash_steps[$crash_index]}
  suffix=$(printf '%03d' "$((10 + crash_index))")
  crash_thread="00000000-0000-4000-8000-000000000$suffix"
  crash_init="$TEST_ROOT/crash-$crash_index-init.json"
  crash_reserve="$TEST_ROOT/crash-$crash_index-reserve.json"
  request_from_fixture initializeRequest "$crash_init" "$crash_thread"
  request_from_fixture reserveRequest "$crash_reserve" "$crash_thread"
  provider_lineage_initialize_advanced_v1 "$crash_init" >/dev/null
  : >"$trace"
  export PROVIDER_LINEAGE_FAIL_AFTER=$crash_step
  provider_lineage_reserve_v1 "$crash_reserve" >/dev/null 2>"$TEST_ROOT/crash-$crash_index.err"
  assert_rc 91 "$?" "$crash_step injection aborts at its exact boundary"
  unset PROVIDER_LINEAGE_FAIL_AFTER
  crash_record="$TEST_ROOT/crash-$crash_index-record.json"
  read_record "$crash_thread" "$crash_record"
  assert_rc 0 "$?" "$crash_step leaves a readable authoritative revision"
  if [[ "$crash_step" == reserve:record_temp_fsync ]]; then
    expected_state=advanced
    expected_revision=1
  else
    expected_state=reserved_before_start
    expected_revision=2
  fi
  assert_eq "$expected_state" "$(json_value "$crash_record" state)" \
    "$crash_step selects only the expected state"
  assert_eq "$expected_revision" "$(json_value "$crash_record" stateRevision)" \
    "$crash_step selects only the expected revision"
  provider_lineage_reserve_v1 "$crash_reserve" >"$TEST_ROOT/crash-$crash_index-retry.json"
  assert_rc 0 "$?" "$crash_step retry converges idempotently"
  assert_eq 2 "$(json_value "$TEST_ROOT/crash-$crash_index-retry.json" stateRevision)" \
    "$crash_step retry never duplicates the CAS transition"
  if [[ "$crash_step" != reserve:record_temp_fsync ]]; then
    if grep -Fx reserve:idempotent_provider_directory_fsync "$trace" >/dev/null; then
      test_ok "$crash_step retry completes the possibly interrupted directory barrier"
    else
      test_fail "$crash_step retry completes the possibly interrupted directory barrier" \
        "missing idempotent provider-directory fsync"
    fi
  fi
done

# Legacy/смешанный писатель, игнорирующий соседний flock, не может быть молча перезаписан.
# CAS повторно сверяет точный снимок inode/содержимого непосредственно перед rename.
mixed_thread='00000000-0000-4000-8000-000000000020'
mixed_init="$TEST_ROOT/mixed-init.json"
mixed_reserve="$TEST_ROOT/mixed-reserve.json"
request_from_fixture initializeRequest "$mixed_init" "$mixed_thread"
request_from_fixture reserveRequest "$mixed_reserve" "$mixed_thread"
provider_lineage_initialize_advanced_v1 "$mixed_init" >/dev/null
mixed_record=$(provider_lineage_record_path_v1 "$provider" "$mixed_thread")
pause_marker="$TEST_ROOT/mixed.pause"
(
  export PROVIDER_LINEAGE_TEST_PAUSE_AFTER_READ=$pause_marker
  provider_lineage_reserve_v1 "$mixed_reserve" \
    >"$TEST_ROOT/mixed.out" 2>"$TEST_ROOT/mixed.err"
  printf '%s\n' "$?" >"$TEST_ROOT/mixed.rc"
) &
mixed_pid=$!
for _poll in {1..500}; do
  [[ -f "$pause_marker" ]] && break
  kill -0 "$mixed_pid" 2>/dev/null || break
  sleep 0.01
done
assert_file_exists "$pause_marker" "mixed-writer test reaches post-read CAS seam"
printf '%s' ' ' >>"$mixed_record"
: >"$pause_marker.release"
wait "$mixed_pid"
assert_eq 78 "$(cat "$TEST_ROOT/mixed.rc")" \
  "out-of-lock record mutation fails closed"
assert_contains "$(cat "$TEST_ROOT/mixed.err")" provider-lineage-concurrent-conflict \
  "mixed writer conflict is named"
provider_lineage_read_v1 "$provider" "$mixed_thread" >/dev/null 2>"$TEST_ROOT/mixed-read.err"
assert_rc 78 "$?" "mixed record corruption excludes the lineage from use"
assert_contains "$(cat "$TEST_ROOT/mixed-read.err")" provider-lineage-corrupt \
  "corrupt mixed record is never treated as a valid winner"

unset PROVIDER_LINEAGE_TRACE_FILE
finish_tests
