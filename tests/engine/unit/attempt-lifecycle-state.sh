#!/usr/bin/env bash
# Проверяет сегментированный lifecycle-журнал попытки: идемпотентность, восстановление
# оборванного хвоста, ротацию и защиту от подмены файлового состояния.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/attempt-lifecycle-state.sh"

vectors="$FACTORY_TESTS_HOME/../fixtures/analytics/lifecycle-event-vectors.json"
schema="$FACTORY_HOME/../schemas/analytics/lifecycle-event.schema.json"
task=42
attempt='a_0123456789abcdef0123456789abcdef'

attempt_dir() {
  local attempt_id=$1 root
  root=$(factory_control_root) || return
  printf '%s/protocol-v2/tasks/t%s/attempts/%s\n' "$root" "$task" "$attempt_id"
}

prepare_attempt() {
  local attempt_id=$1 dir root
  dir=$(attempt_dir "$attempt_id") || return
  root=$(factory_control_root) || return
  mkdir -p -- "$dir" || return
  chmod 700 -- "$root" "$root/protocol-v2" "$root/protocol-v2/tasks" \
    "$root/protocol-v2/tasks/t$task" "$root/protocol-v2/tasks/t$task/attempts" "$dir"
}

lifecycle_dir() {
  printf '%s/lifecycle\n' "$(attempt_dir "$1")"
}

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
else:
    print(value)
PY
}

make_draft() {
  local output=$1 attempt_id=$2 event_id=$3 kind=$4 at=$5 mutation=${6:-}
  python3 - "$vectors" "$output" "$attempt_id" "$event_id" "$kind" "$at" "$mutation" <<'PY'
import json
import sys

fixture, output, attempt_id, event_id, kind, at, mutation = sys.argv[1:]
with open(fixture, encoding="utf-8") as source:
    vectors = json.load(source)
draft = vectors["draft"]
case = vectors["kindCases"].get(kind, vectors["kindCases"]["attempt_started"])
draft.update(vectors["identityClasses"][case["identityClass"]])
draft["details"] = case["details"]
draft["attemptId"] = attempt_id
draft["eventId"] = event_id
draft["kind"] = kind
draft["at"] = at
if mutation == "conflict":
    draft["writerVersion"] = "fixture-conflict"
elif mutation == "unknown":
    draft["unexpected"] = True
elif mutation == "bad-clock":
    draft["clock"]["monotonicNs"] = 1.5
elif mutation == "missing-scope":
    del draft["runId"]
elif mutation == "bad-details":
    draft["details"] = {}
elif mutation == "pinned":
    draft["routeId"] = "route"
    draft["routeHash"] = "a" * 64
elif mutation == "pinned-profile-drift":
    draft["routeId"] = "route"
    draft["routeHash"] = "a" * 64
    draft["profile"] = "other"
elif mutation == "node-drift":
    draft["nodeId"] = "review"
with open(output, "w", encoding="utf-8", newline="") as target:
    json.dump(draft, target, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    target.write("\n")
PY
}

active_file() {
  local lifecycle=$1 active
  active=$(json_value "$lifecycle/manifest.json" activeSegment) || return
  printf '%s/segments/%s\n' "$lifecycle" "$active"
}

prepare_attempt "$attempt" || exit 1
lifecycle=$(lifecycle_dir "$attempt")
trace="$TEST_ROOT/lifecycle.trace"
export ATTEMPT_LIFECYCLE_TRACE_FILE=$trace

# Общий golden фиксирует UTF-16 ordering RFC 8785 subset независимо от Python/Node.
utf16_value="$TEST_ROOT/utf16.json"
python3 - "$vectors" "$utf16_value" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)["utf16Order"]["value"]
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(value, target, ensure_ascii=False)
PY
canonical=$(attempt_lifecycle_canonical_v2 "$utf16_value")
assert_rc 0 "$?" "Python lifecycle helper canonicalizes the shared RFC 8785 subset"
assert_eq "$(json_value "$vectors" utf16Order.canonical)" "$canonical" \
  "Python and Node use the same UTF-16 property order"
assert_eq "$(json_value "$vectors" utf16Order.sha256)" \
  "$(printf '%s' "$canonical" | sha256sum | awk '{print $1}')" \
  "shared canonical bytes have the pinned SHA-256"
assert_eq '["initial","forward_transition","route_rewind","gate_rejected","human_rewind","recovery"]' \
  "$(json_value "$schema" '$defs.visitReason.enum')" "visit reasons are pinned in the shared schema"
assert_eq '["initial","no_result","product_failure","manual_resume"]' \
  "$(json_value "$schema" '$defs.executionReason.enum')" \
  "execution reasons are pinned in the shared schema"
assert_eq '["primary","provider_failover","model_fallback","manual_switch"]' \
  "$(json_value "$schema" '$defs.runReason.enum')" "run reasons are pinned in the shared schema"

"${NODE_BIN:-node}" - "$schema" "$vectors" "$FACTORY_HOME/../server/node_modules/ajv/dist/2020" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [schemaPath, vectorsPath, ajvPath] = process.argv.slice(2);
const Ajv2020 = require(ajvPath).default;
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const golden = {
  ...vectors.draft,
  sequence: 1,
  previousEventHash: null,
  eventHash: vectors.eventHash,
};
const preimage = { ...golden };
delete preimage.eventHash;
if (canonical(preimage) !== vectors.canonicalPreimage) throw new Error('Node canonical preimage drift');
if (crypto.createHash('sha256').update(canonical(preimage), 'utf8').digest('hex') !== vectors.eventHash) {
  throw new Error('Node event hash drift');
}
if (`${canonical(golden)}\n` !== vectors.canonicalLine) throw new Error('Node canonical line drift');
let ordinal = 0;
function eventFor(kind) {
  const testCase = vectors.kindCases[kind];
  ordinal += 1;
  return {
    ...vectors.draft,
    ...vectors.identityClasses[testCase.identityClass],
    kind,
    details: structuredClone(testCase.details),
    eventId: `ev_${ordinal.toString(16).padStart(32, '0')}`,
    sequence: ordinal,
    previousEventHash: ordinal === 1 ? null : 'a'.repeat(64),
    eventHash: 'b'.repeat(64),
  };
}
for (const kind of Object.keys(vectors.kindCases)) {
  const event = eventFor(kind);
  if (!validate(event)) throw new Error(`${kind}: ${JSON.stringify(validate.errors)}`);
}
const missing = eventFor('runner_finished');
delete missing.details.quiescedAt;
const extra = eventFor('attempt_started');
extra.details.freeText = 'forbidden';
const crossKind = eventFor('attempt_resumed');
crossKind.details = structuredClone(vectors.kindCases.attempt_interrupted.details);
const wrongIdentity = eventFor('attempt_started');
wrongIdentity.runId = 'fake-run';
const badFresh = eventFor('runner_started');
badFresh.details.parentUsageRef = structuredClone(vectors.runnerStartedResumeDetails.parentUsageRef);
const badResume = eventFor('runner_started');
badResume.details = structuredClone(vectors.runnerStartedResumeDetails);
badResume.details.parentUsageRef = null;
for (const [name, value] of Object.entries({ missing, extra, crossKind, wrongIdentity, badFresh, badResume })) {
  if (validate(value)) throw new Error(`${name}: invalid vector was accepted`);
}
NODE
assert_rc 0 "$?" "Ajv strict-mode accepts all 40 discriminated kind fixtures and rejects cross-kind drift"

python3 - "$FACTORY_HOME/lib/attempt-lifecycle-state.py" "$schema" "$vectors" <<'PY'
import importlib.util
import copy
import json
import sys

module_path, schema_path, vectors_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("attempt_lifecycle_contract", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
with open(vectors_path, encoding="utf-8") as source:
    vectors = json.load(source)
contract = module.Contract(schema_path)
drafts = {}
for ordinal, (kind, case) in enumerate(vectors["kindCases"].items(), 1):
    event = dict(vectors["draft"])
    event.update(vectors["identityClasses"][case["identityClass"]])
    event.update(kind=kind, details=case["details"], eventId=f"ev_{ordinal:032x}")
    drafts[kind] = copy.deepcopy(event)
    if kind == "lifecycle_tail_recovered":
        event.update(sequence=ordinal, previousEventHash=None, eventHash="b" * 64)
        module.validate_event(event, contract, draft=False)
    else:
        module.validate_event(event, contract, draft=True)

invalid = []
missing = copy.deepcopy(drafts["runner_finished"])
del missing["details"]["quiescedAt"]
invalid.append(missing)
extra = copy.deepcopy(drafts["attempt_started"])
extra["details"]["freeText"] = "forbidden"
invalid.append(extra)
cross_kind = copy.deepcopy(drafts["attempt_resumed"])
cross_kind["details"] = copy.deepcopy(drafts["attempt_interrupted"]["details"])
invalid.append(cross_kind)
wrong_identity = copy.deepcopy(drafts["attempt_started"])
wrong_identity["runId"] = "fake-run"
invalid.append(wrong_identity)
bad_fresh = copy.deepcopy(drafts["runner_started"])
bad_fresh["details"]["parentUsageRef"] = copy.deepcopy(vectors["runnerStartedResumeDetails"]["parentUsageRef"])
invalid.append(bad_fresh)
bad_resume = copy.deepcopy(drafts["runner_started"])
bad_resume["details"] = copy.deepcopy(vectors["runnerStartedResumeDetails"])
bad_resume["details"]["parentUsageRef"] = None
invalid.append(bad_resume)
for event in invalid:
    try:
        module.validate_event(event, contract, draft=True)
    except module.LifecycleFailure as error:
        if error.name != "lifecycle-schema-invalid":
            raise
    else:
        raise AssertionError(f"invalid host draft accepted: {event['kind']}")
PY
assert_rc 0 "$?" "host writer accepts all 40 branches and rejects details/identity cross-kind drift"

: >"$trace"
attempt_lifecycle_init_v2 "$task" "$attempt"
assert_rc 0 "$?" "lifecycle layout initializes under the trusted attempt"
for dir in "$lifecycle" "$lifecycle/segments" "$lifecycle/quarantine" "$lifecycle/usage"; do
  [[ -d "$dir" && ! -L "$dir" ]] \
    && test_ok "$(basename "$dir") is a real lifecycle directory" \
    || test_fail "$(basename "$dir") is a real lifecycle directory" "$dir"
  assert_eq 700 "$(stat -c '%a' "$dir")" "$(basename "$dir") is private"
done
assert_file_exists "$lifecycle/manifest.json" "initial manifest is published"
assert_file_exists "$lifecycle/tail.json" "initial tail projection is published"
initial_active=$(active_file "$lifecycle")
assert_file_exists "$initial_active" "initial active generation is selected"
assert_eq 600 "$(stat -c '%a' "$initial_active")" "active segment is host-private"
assert_eq 1 "$(json_value "$lifecycle/manifest.json" generation)" \
  "initial manifest selects generation one"
assert_eq '[]' "$(json_value "$lifecycle/manifest.json" sealedSegments)" \
  "initial manifest has no sealed segments"
assert_eq $'init:segment_fsync\ninit:segments_directory_fsync\ninit:manifest_temp_fsync\ninit:manifest_cas\ninit:manifest_rename\ninit:lifecycle_directory_fsync' \
  "$(sed -n '1,6p' "$trace")" "initial publish uses the complete fsync barrier and manifest CAS"

# Первый append строит sequence/hash, а line совпадает с cross-language golden byte-for-byte.
draft1="$TEST_ROOT/draft-1.json"
make_draft "$draft1" "$attempt" ev_00000000000000000000000000000001 \
  attempt_started 2026-08-19T01:02:03.004Z
hash1=$(attempt_lifecycle_append_v2 "$task" "$attempt" "$draft1")
assert_rc 0 "$?" "first lifecycle event appends"
assert_eq "$(json_value "$vectors" eventHash)" "$hash1" \
  "eventHash excludes only eventHash and the trailing LF"
expected_line=$(json_value "$vectors" canonicalLine)
actual_line=$(attempt_lifecycle_read_v2 "$task" "$attempt")
assert_rc 0 "$?" "reader validates the complete selected generation"
assert_eq "$expected_line" "$actual_line" "stored line is the shared canonical line"

# Стабильный eventId идемпотентен только для точного повтора.
before_retry=$(sha256sum "$initial_active" | awk '{print $1}')
retry_hash=$(attempt_lifecycle_append_v2 "$task" "$attempt" "$draft1")
assert_rc 0 "$?" "exact stable eventId retry succeeds"
assert_eq "$hash1" "$retry_hash" "exact retry returns the accepted hash"
assert_eq "$before_retry" "$(sha256sum "$initial_active" | awk '{print $1}')" \
  "exact retry does not append a duplicate line"

conflict="$TEST_ROOT/draft-conflict.json"
make_draft "$conflict" "$attempt" ev_00000000000000000000000000000001 \
  attempt_started 2026-08-19T01:02:03.004Z conflict
attempt_lifecycle_append_v2 "$task" "$attempt" "$conflict" \
  >"$TEST_ROOT/conflict.out" 2>"$TEST_ROOT/conflict.err"
assert_rc 73 "$?" "different payload under one stable eventId is rejected"
assert_contains "$(cat "$TEST_ROOT/conflict.err")" lifecycle-event-id-conflict \
  "eventId conflict has a named failure"

unknown="$TEST_ROOT/draft-unknown.json"
make_draft "$unknown" "$attempt" ev_00000000000000000000000000000002 \
  attempt_resumed 2026-08-19T01:02:04.004Z unknown
attempt_lifecycle_append_v2 "$task" "$attempt" "$unknown" \
  >"$TEST_ROOT/unknown.out" 2>"$TEST_ROOT/unknown.err"
assert_rc 78 "$?" "unknown envelope key is rejected before mutation"
assert_contains "$(cat "$TEST_ROOT/unknown.err")" lifecycle-schema-invalid \
  "strict schema rejection is named"

bad_clock="$TEST_ROOT/draft-bad-clock.json"
make_draft "$bad_clock" "$attempt" ev_00000000000000000000000000000002 \
  attempt_resumed 2026-08-19T01:02:04.004Z bad-clock
attempt_lifecycle_append_v2 "$task" "$attempt" "$bad_clock" \
  >"$TEST_ROOT/bad-clock.out" 2>"$TEST_ROOT/bad-clock.err"
assert_rc 78 "$?" "non-integer JCS number is rejected"

missing_scope="$TEST_ROOT/draft-missing-scope.json"
make_draft "$missing_scope" "$attempt" ev_00000000000000000000000000000002 \
  attempt_resumed 2026-08-19T01:02:04.004Z missing-scope
attempt_lifecycle_append_v2 "$task" "$attempt" "$missing_scope" >/dev/null 2>&1
assert_rc 78 "$?" "every nullable scoped identity key is still mandatory"

bad_kind="$TEST_ROOT/draft-bad-kind.json"
make_draft "$bad_kind" "$attempt" ev_00000000000000000000000000000002 \
  free_form_kind 2026-08-19T01:02:04.004Z
attempt_lifecycle_append_v2 "$task" "$attempt" "$bad_kind" >/dev/null 2>&1
assert_rc 78 "$?" "lifecycle kind is a closed shared enum"

bad_id="$TEST_ROOT/draft-bad-id.json"
make_draft "$bad_id" "$attempt" ev_not-an-identity \
  attempt_resumed 2026-08-19T01:02:04.004Z
attempt_lifecycle_append_v2 "$task" "$attempt" "$bad_id" >/dev/null 2>&1
assert_rc 78 "$?" "entity identities follow the shared prefix/hex contract"

bad_details="$TEST_ROOT/draft-bad-details.json"
make_draft "$bad_details" "$attempt" ev_00000000000000000000000000000002 \
  attempt_resumed 2026-08-19T01:02:04.004Z bad-details
attempt_lifecycle_append_v2 "$task" "$attempt" "$bad_details" >/dev/null 2>&1
assert_rc 78 "$?" "ordinary schema-1 event cannot smuggle free-form details"

# Распространение идентичности между событиями проверяется до изменения, а не только
# отдельно для каждой строки.
identity_attempt='a_12121212121212121212121212121212'
prepare_attempt "$identity_attempt"
attempt_lifecycle_init_v2 "$task" "$identity_attempt" >/dev/null
identity_start="$TEST_ROOT/identity-start.json"
identity_route="$TEST_ROOT/identity-route.json"
identity_unpinned="$TEST_ROOT/identity-unpinned.json"
identity_pinned="$TEST_ROOT/identity-pinned.json"
identity_profile="$TEST_ROOT/identity-profile.json"
identity_visit="$TEST_ROOT/identity-visit.json"
identity_visit_drift="$TEST_ROOT/identity-visit-drift.json"
make_draft "$identity_start" "$identity_attempt" ev_12121212121212121212121212121211 \
  attempt_started 2026-08-19T01:10:00.000Z
make_draft "$identity_route" "$identity_attempt" ev_12121212121212121212121212121212 \
  route_selected 2026-08-19T01:10:01.000Z
make_draft "$identity_unpinned" "$identity_attempt" ev_12121212121212121212121212121213 \
  attempt_interrupted 2026-08-19T01:10:02.000Z
make_draft "$identity_pinned" "$identity_attempt" ev_12121212121212121212121212121213 \
  attempt_interrupted 2026-08-19T01:10:02.000Z pinned
make_draft "$identity_profile" "$identity_attempt" ev_12121212121212121212121212121214 \
  attempt_interrupted 2026-08-19T01:10:03.000Z pinned-profile-drift
make_draft "$identity_visit" "$identity_attempt" ev_12121212121212121212121212121215 \
  node_visit_started 2026-08-19T01:10:04.000Z
make_draft "$identity_visit_drift" "$identity_attempt" ev_12121212121212121212121212121216 \
  node_visit_finished 2026-08-19T01:10:05.000Z node-drift
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_start" >/dev/null
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_route" >/dev/null
identity_before=$(sha256sum "$(active_file "$(lifecycle_dir "$identity_attempt")")" | awk '{print $1}')
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_unpinned" >/dev/null 2>&1
assert_rc 78 "$?" "post-pin event cannot drop immutable route identity"
assert_eq "$identity_before" \
  "$(sha256sum "$(active_file "$(lifecycle_dir "$identity_attempt")")" | awk '{print $1}')" \
  "cross-event route validation happens before append mutation"
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_pinned" >/dev/null
assert_rc 0 "$?" "post-pin event with the exact route identity appends"
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_profile" >/dev/null 2>&1
assert_rc 78 "$?" "attempt profile cannot drift within one ledger"
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_visit" >/dev/null
assert_rc 0 "$?" "node visit introduces a scoped identity under the pinned route"
attempt_lifecycle_append_v2 "$task" "$identity_attempt" "$identity_visit_drift" >/dev/null 2>&1
assert_rc 78 "$?" "nodeVisitId cannot be reused with a different node identity"

# Два независимых writer process сериализуются отдельным lifecycle flock.
draft2="$TEST_ROOT/draft-2.json"
draft3="$TEST_ROOT/draft-3.json"
make_draft "$draft2" "$attempt" ev_00000000000000000000000000000002 \
  attempt_resumed 2026-08-19T01:02:05.004Z
make_draft "$draft3" "$attempt" ev_00000000000000000000000000000003 \
  attempt_interrupted 2026-08-19T01:02:06.004Z
attempt_lifecycle_append_v2 "$task" "$attempt" "$draft2" \
  >"$TEST_ROOT/concurrent-2.out" 2>"$TEST_ROOT/concurrent-2.err" &
pid2=$!
attempt_lifecycle_append_v2 "$task" "$attempt" "$draft3" \
  >"$TEST_ROOT/concurrent-3.out" 2>"$TEST_ROOT/concurrent-3.err" &
pid3=$!
wait "$pid2"; rc2=$?
wait "$pid3"; rc3=$?
assert_rc 0 "$rc2" "first concurrent append succeeds"
assert_rc 0 "$rc3" "second concurrent append succeeds"
attempt_lifecycle_validate_v2 "$task" "$attempt"
assert_rc 0 "$?" "concurrent appends preserve one sequence/hash chain"
assert_eq 3 "$(attempt_lifecycle_read_v2 "$task" "$attempt" | wc -l)" \
  "concurrent writers publish every event exactly once"

# Читатель сообщает об оборванном активном хвосте без изменения; писатель помещает его
# в карантин, копирует валидный префикс в новое поколение, записывает одно событие
# восстановления, переключает manifest и только затем дописывает событие вызывающего.
active_before_recovery=$(active_file "$lifecycle")
valid_bytes=$(stat -c '%s' "$active_before_recovery")
printf '%s' '{"torn":' >>"$active_before_recovery"
source_sha=$(sha256sum "$active_before_recovery" | awk '{print $1}')
source_size=$(stat -c '%s' "$active_before_recovery")
attempt_lifecycle_read_v2 "$task" "$attempt" \
  >"$TEST_ROOT/torn-read.out" 2>"$TEST_ROOT/torn-read.err"
assert_rc 74 "$?" "reader exposes lifecycleIncomplete for a torn active tail"
assert_eq "$source_sha" "$(sha256sum "$active_before_recovery" | awk '{print $1}')" \
  "reader never repairs a torn ledger"

draft4="$TEST_ROOT/draft-4.json"
make_draft "$draft4" "$attempt" ev_00000000000000000000000000000004 \
  attempt_resumed 2026-08-19T01:02:07.004Z
: >"$trace"
hash4=$(attempt_lifecycle_append_v2 "$task" "$attempt" "$draft4")
assert_rc 0 "$?" "writer recovers a torn active tail before append"
assert_file_exists "$lifecycle/quarantine/$source_sha.ndjson" \
  "original torn bytes are content-addressed quarantine evidence"
assert_eq "$source_size" "$(stat -c '%s' "$lifecycle/quarantine/$source_sha.ndjson")" \
  "quarantine preserves every source byte"
assert_eq 2 "$(json_value "$lifecycle/manifest.json" generation)" \
  "manifest switches to a new active generation"
assert_eq 5 "$(attempt_lifecycle_read_v2 "$task" "$attempt" | wc -l)" \
  "valid prefix, one recovery event and caller event survive"
recovery_fields=$(attempt_lifecycle_read_v2 "$task" "$attempt" | python3 -c '
import json, sys
rows=[json.loads(line) for line in sys.stdin]
recovery=[row for row in rows if row["kind"] == "lifecycle_tail_recovered"]
assert len(recovery) == 1
item=recovery[0]
print(item["details"]["validBytes"], item["details"]["discardedBytes"], item["details"]["sourceSegmentSha256"])
')
assert_eq "$valid_bytes $((source_size - valid_bytes)) $source_sha" "$recovery_fields" \
  "recovery event names source hash, valid prefix and discarded tail"
assert_eq $'recovery:quarantine_file_fsync\nrecovery:quarantine_directory_fsync\nrecovery:generation_file_fsync\nrecovery:segments_directory_fsync\nrecovery:manifest_temp_fsync\nrecovery:manifest_cas\nrecovery:manifest_rename\nrecovery:lifecycle_directory_fsync' \
  "$(grep '^recovery:' "$trace" | sed -n '1,8p')" \
  "recovery selects a generation only after every required fsync"
[[ "$hash4" =~ ^[a-f0-9]{64}$ ]] \
  && test_ok "post-recovery caller event is sealed" \
  || test_fail "post-recovery caller event is sealed" "$hash4"

# Падение до переключения manifest безопасно повторяет восстановление; осиротевшее
# поколение не читается.
crash_before='a_22222222222222222222222222222222'
prepare_attempt "$crash_before"
attempt_lifecycle_init_v2 "$task" "$crash_before" >/dev/null
crash_base="$TEST_ROOT/crash-before-base.json"
crash_next="$TEST_ROOT/crash-before-next.json"
make_draft "$crash_base" "$crash_before" ev_22222222222222222222222222222221 \
  attempt_started 2026-08-19T02:00:00.000Z
make_draft "$crash_next" "$crash_before" ev_22222222222222222222222222222222 \
  attempt_resumed 2026-08-19T02:00:01.000Z
attempt_lifecycle_append_v2 "$task" "$crash_before" "$crash_base" >/dev/null
printf '%s' 'partial' >>"$(active_file "$(lifecycle_dir "$crash_before")")"
export ATTEMPT_LIFECYCLE_FAIL_AFTER='recovery:manifest_temp_fsync'
attempt_lifecycle_append_v2 "$task" "$crash_before" "$crash_next" \
  >"$TEST_ROOT/crash-before.out" 2>"$TEST_ROOT/crash-before.err"
assert_rc 91 "$?" "injected crash before manifest switch aborts append"
unset ATTEMPT_LIFECYCLE_FAIL_AFTER
assert_eq 1 "$(json_value "$(lifecycle_dir "$crash_before")/manifest.json" generation)" \
  "pre-switch crash leaves the old generation selected"
attempt_lifecycle_append_v2 "$task" "$crash_before" "$crash_next" >/dev/null
assert_rc 0 "$?" "recovery safely retries after a pre-switch crash"
assert_eq 1 "$(attempt_lifecycle_read_v2 "$task" "$crash_before" | \
  grep -c '"kind":"lifecycle_tail_recovered"')" \
  "retried recovery is recorded exactly once"

# Падение после долговечного переключения manifest видит полное поколение восстановления
# и повторяет только событие вызывающего; tail.json пересобирается из источника истины.
crash_after='a_33333333333333333333333333333333'
prepare_attempt "$crash_after"
attempt_lifecycle_init_v2 "$task" "$crash_after" >/dev/null
after_base="$TEST_ROOT/crash-after-base.json"
after_next="$TEST_ROOT/crash-after-next.json"
make_draft "$after_base" "$crash_after" ev_33333333333333333333333333333331 \
  attempt_started 2026-08-19T03:00:00.000Z
make_draft "$after_next" "$crash_after" ev_33333333333333333333333333333332 \
  attempt_resumed 2026-08-19T03:00:01.000Z
attempt_lifecycle_append_v2 "$task" "$crash_after" "$after_base" >/dev/null
printf '%s' 'partial' >>"$(active_file "$(lifecycle_dir "$crash_after")")"
export ATTEMPT_LIFECYCLE_FAIL_AFTER='recovery:lifecycle_directory_fsync'
attempt_lifecycle_append_v2 "$task" "$crash_after" "$after_next" \
  >"$TEST_ROOT/crash-after.out" 2>"$TEST_ROOT/crash-after.err"
assert_rc 91 "$?" "injected crash after manifest switch aborts caller append"
unset ATTEMPT_LIFECYCLE_FAIL_AFTER
assert_eq 2 "$(json_value "$(lifecycle_dir "$crash_after")/manifest.json" generation)" \
  "post-switch crash leaves the recovered generation selected"
after_hash=$(attempt_lifecycle_append_v2 "$task" "$crash_after" "$after_next")
assert_rc 0 "$?" "append resumes from the selected recovery generation"
assert_eq 1 "$(attempt_lifecycle_read_v2 "$task" "$crash_after" | \
  grep -c '"kind":"lifecycle_tail_recovered"')" \
  "post-switch retry never duplicates recovery"
assert_eq 3 "$(json_value "$(lifecycle_dir "$crash_after")/tail.json" sequence)" \
  "post-switch retry rebuilds stale tail sequence from selected authority"
assert_eq "$after_hash" "$(json_value "$(lifecycle_dir "$crash_after")/tail.json" eventHash)" \
  "rebuilt tail hash points at the accepted caller event"

# Каждую границу долговечности до переключения можно прервать независимо. Ни одна не
# должна выбрать осиротевший temp/поколение, а любой повтор сходится к одному событию восстановления.
matrix_steps=(
  recovery:quarantine_file_fsync
  recovery:quarantine_directory_fsync
  recovery:generation_file_fsync
  recovery:segments_directory_fsync
  recovery:manifest_rename
)
matrix_ordinals=(7 8 9 10 11)
for matrix_index in "${!matrix_steps[@]}"; do
  step=${matrix_steps[$matrix_index]}
  ordinal=${matrix_ordinals[$matrix_index]}
  hex=$(printf '%032x' "$ordinal")
  matrix_attempt="a_$hex"
  prepare_attempt "$matrix_attempt"
  attempt_lifecycle_init_v2 "$task" "$matrix_attempt" >/dev/null
  matrix_base="$TEST_ROOT/matrix-$ordinal-base.json"
  matrix_next="$TEST_ROOT/matrix-$ordinal-next.json"
  make_draft "$matrix_base" "$matrix_attempt" ev_77777777777777777777777777777771 \
    attempt_started 2026-08-19T07:00:00.000Z
  make_draft "$matrix_next" "$matrix_attempt" ev_77777777777777777777777777777772 \
    attempt_resumed 2026-08-19T07:00:01.000Z
  attempt_lifecycle_append_v2 "$task" "$matrix_attempt" "$matrix_base" >/dev/null
  printf '%s' 'partial' >>"$(active_file "$(lifecycle_dir "$matrix_attempt")")"
  export ATTEMPT_LIFECYCLE_FAIL_AFTER=$step
  attempt_lifecycle_append_v2 "$task" "$matrix_attempt" "$matrix_next" >/dev/null 2>&1
  assert_rc 91 "$?" "$step crash injection reaches its exact durability boundary"
  unset ATTEMPT_LIFECYCLE_FAIL_AFTER
  if [[ "$step" == recovery:manifest_rename ]]; then
    expected_generation=2
  else
    expected_generation=1
  fi
  assert_eq "$expected_generation" \
    "$(json_value "$(lifecycle_dir "$matrix_attempt")/manifest.json" generation)" \
    "$step leaves only the expected manifest generation selected"
  matrix_hash=$(attempt_lifecycle_append_v2 "$task" "$matrix_attempt" "$matrix_next")
  assert_rc 0 "$?" "$step retry converges"
  assert_eq 1 "$(attempt_lifecycle_read_v2 "$task" "$matrix_attempt" | \
    grep -c '"kind":"lifecycle_tail_recovered"')" \
    "$step retry records recovery exactly once"
  assert_eq "$matrix_hash" \
    "$(json_value "$(lifecycle_dir "$matrix_attempt")/tail.json" eventHash)" \
    "$step retry rebuilds the authoritative tail"
done

# Полная невалидная строка — это повреждение, а не восстанавливаемый хвост.
corrupt='a_44444444444444444444444444444444'
prepare_attempt "$corrupt"
attempt_lifecycle_init_v2 "$task" "$corrupt" >/dev/null
corrupt_base="$TEST_ROOT/corrupt-base.json"
corrupt_next="$TEST_ROOT/corrupt-next.json"
make_draft "$corrupt_base" "$corrupt" ev_44444444444444444444444444444441 \
  attempt_started 2026-08-19T04:00:00.000Z
make_draft "$corrupt_next" "$corrupt" ev_44444444444444444444444444444442 \
  attempt_resumed 2026-08-19T04:00:01.000Z
attempt_lifecycle_append_v2 "$task" "$corrupt" "$corrupt_base" >/dev/null
corrupt_active=$(active_file "$(lifecycle_dir "$corrupt")")
printf '%s\n' '{bad-json}' >>"$corrupt_active"
corrupt_sha=$(sha256sum "$corrupt_active" | awk '{print $1}')
attempt_lifecycle_append_v2 "$task" "$corrupt" "$corrupt_next" \
  >"$TEST_ROOT/corruption.out" 2>"$TEST_ROOT/corruption.err"
assert_rc 78 "$?" "newline-terminated invalid event blocks append"
assert_contains "$(cat "$TEST_ROOT/corruption.err")" lifecycle-corruption \
  "complete corruption has a named failure"
assert_eq "$corrupt_sha" "$(sha256sum "$corrupt_active" | awk '{print $1}')" \
  "writer never truncates newline-terminated corruption"
quarantine_count=$(find "$(lifecycle_dir "$corrupt")/quarantine" -type f | wc -l)
assert_eq 0 "$quarantine_count" "complete corruption is never mislabeled as torn-tail evidence"

# Несовпадение хеша в середине active и любое повреждение запечатанного сегмента также
# блокируют изменение.
middle='a_55555555555555555555555555555555'
prepare_attempt "$middle"
attempt_lifecycle_init_v2 "$task" "$middle" >/dev/null
middle_a="$TEST_ROOT/middle-a.json"
middle_b="$TEST_ROOT/middle-b.json"
middle_c="$TEST_ROOT/middle-c.json"
make_draft "$middle_a" "$middle" ev_55555555555555555555555555555551 \
  attempt_started 2026-08-19T05:00:00.000Z
make_draft "$middle_b" "$middle" ev_55555555555555555555555555555552 \
  attempt_resumed 2026-08-19T05:00:01.000Z
make_draft "$middle_c" "$middle" ev_55555555555555555555555555555553 \
  attempt_interrupted 2026-08-19T05:00:02.000Z
attempt_lifecycle_append_v2 "$task" "$middle" "$middle_a" >/dev/null
attempt_lifecycle_append_v2 "$task" "$middle" "$middle_b" >/dev/null
middle_active=$(active_file "$(lifecycle_dir "$middle")")
sed -i '0,/fixture-1/s//fixture-X/' "$middle_active"
attempt_lifecycle_append_v2 "$task" "$middle" "$middle_c" >/dev/null 2>&1
assert_rc 78 "$?" "middle event hash corruption blocks append"

sealed='a_66666666666666666666666666666666'
prepare_attempt "$sealed"
attempt_lifecycle_init_v2 "$task" "$sealed" >/dev/null
sealed_a="$TEST_ROOT/sealed-a.json"
sealed_b="$TEST_ROOT/sealed-b.json"
sealed_c="$TEST_ROOT/sealed-c.json"
sealed_d="$TEST_ROOT/sealed-d.json"
make_draft "$sealed_a" "$sealed" ev_66666666666666666666666666666661 \
  attempt_started 2026-08-19T06:00:00.000Z
make_draft "$sealed_b" "$sealed" ev_66666666666666666666666666666662 \
  attempt_resumed 2026-08-19T06:00:01.000Z
make_draft "$sealed_c" "$sealed" ev_66666666666666666666666666666663 \
  attempt_interrupted 2026-08-19T06:00:02.000Z
make_draft "$sealed_d" "$sealed" ev_66666666666666666666666666666664 \
  attempt_resumed 2026-08-19T06:00:03.000Z
export FACTORY_LIFECYCLE_SEGMENT_BYTES=1
attempt_lifecycle_append_v2 "$task" "$sealed" "$sealed_a" >/dev/null
sealed_lifecycle=$(lifecycle_dir "$sealed")
assert_eq 1 "$(json_value "$sealed_lifecycle/manifest.json" generation)" \
  "empty active accepts one bounded event instead of creating an empty seal"
: >"$trace"
attempt_lifecycle_append_v2 "$task" "$sealed" "$sealed_b" >/dev/null
assert_rc 0 "$?" "size target rotates a non-empty active segment before append"
assert_eq 2 "$(json_value "$sealed_lifecycle/manifest.json" generation)" \
  "rotation atomically selects the next manifest generation"
assert_eq 1 "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.0.eventCount)" \
  "sealed descriptor pins its exact event count"
sealed_name=$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.0.name)
sealed_path="$sealed_lifecycle/segments/$sealed_name"
assert_eq 400 "$(stat -c '%a' "$sealed_path")" "sealed segment is immutable to normal writers"
assert_eq "$(stat -c '%s' "$sealed_path")" \
  "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.0.byteLength)" \
  "sealed descriptor pins exact byte length"
assert_eq "$(sha256sum "$sealed_path" | awk '{print $1}')" \
  "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.0.contentSha256)" \
  "sealed descriptor pins the content hash"
assert_eq $'rotation:sealed_file_fsync\nrotation:active_file_fsync\nrotation:segments_directory_fsync\nrotation:manifest_temp_fsync\nrotation:manifest_cas\nrotation:manifest_rename\nrotation:lifecycle_directory_fsync' \
  "$(grep '^rotation:' "$trace" | sed -n '1,7p')" \
  "rotation completes both segment fsyncs before the manifest CAS barrier"
attempt_lifecycle_init_v2 "$task" "$sealed" >/dev/null
assert_rc 0 "$?" "restart validates and reuses the selected rotated generation"
assert_eq 2 "$(attempt_lifecycle_read_v2 "$task" "$sealed" | wc -l)" \
  "restart reads one continuous event hash chain across sealed and active"
attempt_lifecycle_append_v2 "$task" "$sealed" "$sealed_c" >/dev/null
assert_rc 0 "$?" "a later append performs a second real rotation"
assert_eq 1 "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.1.eventCount)" \
  "second rotation seals exactly the previously active event"
assert_eq "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.0.contentSha256)" \
  "$(json_value "$sealed_lifecycle/manifest.json" sealedSegments.1.previousSegmentSha256)" \
  "sealed descriptors form their own ordered content-hash chain"
assert_eq 3 "$(attempt_lifecycle_read_v2 "$task" "$sealed" | wc -l)" \
  "two sealed segments and active preserve one event chain"
chmod 600 "$sealed_path"
sed -i '0,/fixture-1/s//fixture-X/' "$sealed_path"
chmod 400 "$sealed_path"
attempt_lifecycle_append_v2 "$task" "$sealed" "$sealed_b" >/dev/null 2>&1
assert_rc 78 "$?" "sealed segment corruption blocks append"

# Сравнение порога точное: равенство остаётся в active, один байт ниже запускает ротацию.
boundary_reference='a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
prepare_attempt "$boundary_reference"
attempt_lifecycle_init_v2 "$task" "$boundary_reference" >/dev/null
boundary_ref_a="$TEST_ROOT/boundary-ref-a.json"
boundary_ref_b="$TEST_ROOT/boundary-ref-b.json"
make_draft "$boundary_ref_a" "$boundary_reference" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 \
  attempt_started 2026-08-19T06:10:00.000Z
make_draft "$boundary_ref_b" "$boundary_reference" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2 \
  attempt_resumed 2026-08-19T06:10:01.000Z
export FACTORY_LIFECYCLE_SEGMENT_BYTES=262144
attempt_lifecycle_append_v2 "$task" "$boundary_reference" "$boundary_ref_a" >/dev/null
attempt_lifecycle_append_v2 "$task" "$boundary_reference" "$boundary_ref_b" >/dev/null
boundary_bytes=$(stat -c '%s' "$(active_file "$(lifecycle_dir "$boundary_reference")")")

boundary_exact='a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3'
prepare_attempt "$boundary_exact"
attempt_lifecycle_init_v2 "$task" "$boundary_exact" >/dev/null
boundary_exact_a="$TEST_ROOT/boundary-exact-a.json"
boundary_exact_b="$TEST_ROOT/boundary-exact-b.json"
make_draft "$boundary_exact_a" "$boundary_exact" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3 \
  attempt_started 2026-08-19T06:10:00.000Z
make_draft "$boundary_exact_b" "$boundary_exact" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4 \
  attempt_resumed 2026-08-19T06:10:01.000Z
export FACTORY_LIFECYCLE_SEGMENT_BYTES=$boundary_bytes
attempt_lifecycle_append_v2 "$task" "$boundary_exact" "$boundary_exact_a" >/dev/null
attempt_lifecycle_append_v2 "$task" "$boundary_exact" "$boundary_exact_b" >/dev/null
assert_eq 1 "$(json_value "$(lifecycle_dir "$boundary_exact")/manifest.json" generation)" \
  "active size exactly equal to the target does not rotate"

boundary_below='a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5'
prepare_attempt "$boundary_below"
attempt_lifecycle_init_v2 "$task" "$boundary_below" >/dev/null
boundary_below_a="$TEST_ROOT/boundary-below-a.json"
boundary_below_b="$TEST_ROOT/boundary-below-b.json"
make_draft "$boundary_below_a" "$boundary_below" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5 \
  attempt_started 2026-08-19T06:10:00.000Z
make_draft "$boundary_below_b" "$boundary_below" ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6 \
  attempt_resumed 2026-08-19T06:10:01.000Z
export FACTORY_LIFECYCLE_SEGMENT_BYTES=$((boundary_bytes - 1))
attempt_lifecycle_append_v2 "$task" "$boundary_below" "$boundary_below_a" >/dev/null
attempt_lifecycle_append_v2 "$task" "$boundary_below" "$boundary_below_b" >/dev/null
assert_eq 2 "$(json_value "$(lifecycle_dir "$boundary_below")/manifest.json" generation)" \
  "active size one byte above the target rotates before append"
export FACTORY_LIFECYCLE_SEGMENT_BYTES=1

# Подмена дескриптора — повреждение, даже если байты запечатанного события остаются валидными.
descriptor_attempt='a_77777777777777777777777777777777'
prepare_attempt "$descriptor_attempt"
attempt_lifecycle_init_v2 "$task" "$descriptor_attempt" >/dev/null
descriptor_a="$TEST_ROOT/descriptor-a.json"
descriptor_b="$TEST_ROOT/descriptor-b.json"
descriptor_c="$TEST_ROOT/descriptor-c.json"
make_draft "$descriptor_a" "$descriptor_attempt" ev_77777777777777777777777777777771 \
  attempt_started 2026-08-19T07:00:00.000Z
make_draft "$descriptor_b" "$descriptor_attempt" ev_77777777777777777777777777777772 \
  attempt_resumed 2026-08-19T07:00:01.000Z
make_draft "$descriptor_c" "$descriptor_attempt" ev_77777777777777777777777777777773 \
  attempt_interrupted 2026-08-19T07:00:02.000Z
attempt_lifecycle_append_v2 "$task" "$descriptor_attempt" "$descriptor_a" >/dev/null
attempt_lifecycle_append_v2 "$task" "$descriptor_attempt" "$descriptor_b" >/dev/null
descriptor_lifecycle=$(lifecycle_dir "$descriptor_attempt")
python3 - "$descriptor_lifecycle/manifest.json" <<'PY'
import json
import os
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
value["sealedSegments"][0]["contentSha256"] = "e" * 64
with open(sys.argv[1], "w", encoding="utf-8", newline="") as target:
    json.dump(value, target, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    target.write("\n")
os.chmod(sys.argv[1], 0o600)
PY
attempt_lifecycle_append_v2 "$task" "$descriptor_attempt" "$descriptor_c" >/dev/null 2>&1
assert_rc 78 "$?" "sealed descriptor corruption blocks append"

# Каждая граница долговечности ротации независимо перезапускаема. До CAS rename старый
# manifest остаётся источником истины; после rename ожидающее событие уже выбрано.
rotation_steps=(
  rotation:sealed_file_fsync
  rotation:active_file_fsync
  rotation:segments_directory_fsync
  rotation:manifest_temp_fsync
  rotation:manifest_cas
  rotation:manifest_rename
  rotation:lifecycle_directory_fsync
  rotation:tail_temp_fsync
)
for rotation_index in "${!rotation_steps[@]}"; do
  step=${rotation_steps[$rotation_index]}
  ordinal=$((80 + rotation_index))
  hex=$(printf '%032x' "$ordinal")
  rotation_attempt="a_$hex"
  prepare_attempt "$rotation_attempt"
  attempt_lifecycle_init_v2 "$task" "$rotation_attempt" >/dev/null
  rotation_a="$TEST_ROOT/rotation-$ordinal-a.json"
  rotation_b="$TEST_ROOT/rotation-$ordinal-b.json"
  make_draft "$rotation_a" "$rotation_attempt" "ev_${hex}" \
    attempt_started 2026-08-19T08:00:00.000Z
  next_hex=$(printf '%032x' "$((ordinal + 100))")
  make_draft "$rotation_b" "$rotation_attempt" "ev_${next_hex}" \
    attempt_resumed 2026-08-19T08:00:01.000Z
  attempt_lifecycle_append_v2 "$task" "$rotation_attempt" "$rotation_a" >/dev/null
  export ATTEMPT_LIFECYCLE_FAIL_AFTER=$step
  attempt_lifecycle_append_v2 "$task" "$rotation_attempt" "$rotation_b" >/dev/null 2>&1
  assert_rc 91 "$?" "$step crash injection reaches the exact rotation boundary"
  unset ATTEMPT_LIFECYCLE_FAIL_AFTER
  case "$step" in
    rotation:manifest_rename|rotation:lifecycle_directory_fsync|rotation:tail_temp_fsync)
      expected_generation=2
      ;;
    *)
      expected_generation=1
      ;;
  esac
  assert_eq "$expected_generation" \
    "$(json_value "$(lifecycle_dir "$rotation_attempt")/manifest.json" generation)" \
    "$step leaves one whole manifest generation selected"
  rotation_hash=$(attempt_lifecycle_append_v2 "$task" "$rotation_attempt" "$rotation_b")
  assert_rc 0 "$?" "$step retry converges without replacing committed bytes"
  assert_eq 2 "$(attempt_lifecycle_read_v2 "$task" "$rotation_attempt" | wc -l)" \
    "$step retry preserves each stable event exactly once"
  assert_eq "$rotation_hash" \
    "$(json_value "$(lifecycle_dir "$rotation_attempt")/tail.json" eventHash)" \
    "$step retry rebuilds tail from manifest authority"
done

# Точный отпечаток manifest проверяется прямо перед заменой: одного поколения недостаточно
# при смешанном или несотрудничающем писателе.
cas_attempt='a_99999999999999999999999999999999'
prepare_attempt "$cas_attempt"
attempt_lifecycle_init_v2 "$task" "$cas_attempt" >/dev/null
cas_lifecycle=$(lifecycle_dir "$cas_attempt")
python3 - "$FACTORY_HOME/lib/attempt-lifecycle-state.py" "$schema" "$cas_lifecycle" <<'PY'
import importlib.util
import os
import sys

module_path, schema_path, lifecycle = sys.argv[1:]
spec = importlib.util.spec_from_file_location("attempt_lifecycle_cas", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
contract = module.Contract(schema_path)
ledger = module.load_ledger(lifecycle, "t42", os.path.basename(os.path.dirname(lifecycle)), contract)
manifest_path = os.path.join(lifecycle, "manifest.json")
active_path = os.path.join(lifecycle, "segments", ledger.manifest["activeSegment"])
active_info = os.stat(active_path)
os.utime(active_path, ns=(active_info.st_atime_ns, active_info.st_mtime_ns + 1_000_000_000))
try:
    module.assert_active_unchanged(lifecycle, ledger)
except module.LifecycleFailure as error:
    if error.name != "lifecycle-manifest-conflict":
        raise
else:
    raise AssertionError("stale active snapshot was accepted")
with open(manifest_path, "rb") as source:
    manifest_bytes = source.read()
info = os.stat(manifest_path)
os.utime(manifest_path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
try:
    module.publish_manifest_cas(lifecycle, manifest_bytes, ledger.manifest_snapshot, context="cas-test")
except module.LifecycleFailure as error:
    if error.name != "lifecycle-manifest-conflict":
        raise
else:
    raise AssertionError("stale manifest snapshot was accepted")
PY
assert_rc 0 "$?" "active/manifest CAS reject exact-generation files whose fingerprints changed"
assert_eq 1 "$(json_value "$cas_lifecycle/manifest.json" generation)" \
  "failed manifest CAS never replaces the current generation"

unset FACTORY_LIFECYCLE_SEGMENT_BYTES

unset ATTEMPT_LIFECYCLE_TRACE_FILE
finish_tests
