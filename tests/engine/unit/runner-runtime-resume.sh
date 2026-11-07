#!/usr/bin/env bash
# Проверяет runtime-мост возобновлённого запуска: приватный baseline вычитается из
# нормализатора, но не попадает в опубликованный usage-документ.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

usage_dir="$TEST_ROOT/usage"
mkdir -p -- "$usage_dir"
chmod 700 -- "$usage_dir"
control=$(factory_control_root) || exit 1
mkdir -p -- "$control" || exit 1
chmod 700 -- "$control"

json_value() {
  runtime_analytics_json_get_v2 "$1" "$2"
}

make_parent_document() {
  local run_id=$1 observed_scope=$2 checkpoint_scope=$3 completeness=$4
  local eligible=$5 checkpoint_hash=$6 output=$7
  "$NODE_BIN" --input-type=module - \
    "$FACTORY_HOME/../server/src/lib/analytics/usageDocument.ts" \
    "$run_id" "$observed_scope" "$checkpoint_scope" "$completeness" \
    "$eligible" "$checkpoint_hash" "$output" <<'NODE'
import { chmodSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, runId, observedScope, checkpointScope, completeness,
  eligibleRaw, checkpointHash, output] = process.argv.slice(2);
const { buildUsageDocument, encodeUsageDocument } = await import(pathToFileURL(modulePath));
const { ANALYTICS_EXTRACTOR_VERSION } = await import(
  new URL('./normalizers.ts', pathToFileURL(modulePath)),
);
const eligible = eligibleRaw === 'true';
const vector = Object.freeze({
  inputTokens: '10', cachedInputTokens: '4', cacheWriteInputTokens: '1',
  outputTokens: '3', reasoningOutputTokens: '1',
});
const terminalCounterCheckpoint = completeness === 'complete' || eligible
  ? Object.freeze({
    counterScope: checkpointScope,
    counterGeneration: '0',
    vector,
    presenceMask: Object.keys(vector),
    dialect: 'codex-jsonl-v1',
    extractorVersion: ANALYTICS_EXTRACTOR_VERSION,
    lifecycleEventHash: 'a'.repeat(64),
    checkpointHash,
    resumeEligible: eligible,
  })
  : null;
const zeros = Object.freeze({
  uncachedInput: '0', output: '0', cacheRead: '0',
  cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
});
const document = buildUsageDocument({
  identity: {
    taskId: 't91', attemptId: 'a_91919191919191919191919191919191',
    nodeVisitId: 'nv_11111111111111111111111111111111',
    nodeExecutionId: 'ne_22222222222222222222222222222222',
    dispatchId: 'd_33333333333333333333333333333333',
    runId, epoch: 1,
  },
  provider: 'codex',
  requestedModel: 'gpt-test',
  resolvedModel: 'gpt-test',
  observedAt: '2026-08-20T02:00:00.000Z',
  sourceFingerprint: {
    dev: '1', ino: '2', size: '3', mtimeNs: '4',
    sha256: 'b'.repeat(64), finalFstatHash: 'c'.repeat(64),
    rawFsyncCompleted: true,
  },
  providerSessionMode: 'fresh',
  requestedProviderScope: null,
  observedProviderScope: observedScope,
  parentUsageRef: null,
  normalization: {
    provider: 'codex', normalizerDialect: 'codex-jsonl-v1',
    extractorVersion: ANALYTICS_EXTRACTOR_VERSION,
    source: completeness === 'complete' ? 'provider_final' : 'provider_partial',
    completeness, provenance: 'exact', samples: [], usageSegments: [],
    tokenSummary: zeros, providerReportedCost: null, providerRootResult: null,
    terminalCounterCheckpoint,
    lastObservedCounter: terminalCounterCheckpoint === null
      ? { counterScope: checkpointScope, vector, resumeEligible: false }
      : null,
    diagnostics: [],
  },
});
writeFileSync(output, encodeUsageDocument(document), { flag: 'wx', mode: 0o600 });
chmodSync(output, 0o600);
NODE
}

initialize_lineage() {
  local scope=$1 run_id=$2 document_hash=$3 checkpoint_hash=$4 request=$5
  runtime_analytics_json_v2 \
    schemaVersion integer 1 protocolVersion integer 2 \
    provider string codex threadId string "$scope" lineageGeneration integer 0 \
    runId string "$run_id" usageDocumentHash string "$document_hash" \
    checkpointHash string "$checkpoint_hash" \
    runnerUsageRecordedEventHash string "$(printf c%.0s {1..64})" \
    runnerScopeBoundEventHash string "$(printf d%.0s {1..64})" \
    usageCompleteness string complete resumeEligible boolean true >"$request"
  provider_lineage_initialize_advanced_v1 "$request" >/dev/null
}

reserve_runtime() {
  local scope=$1 child=$2
  export FACTORY_PROVIDER_SESSION_MODE=resume
  export FACTORY_PROVIDER_REQUESTED_SCOPE=$scope
  _runner_lineage_reset_v2
  _runner_lineage_reserve_v2 codex "$child" 'native_resume_v1' \
    "$usage_dir" codex-jsonl-v1
}

assert_advanced() {
  local scope=$1 label=$2 record
  record="$TEST_ROOT/$label-record.json"
  provider_lineage_read_v1 codex "$scope" >"$record"
  assert_eq advanced "$(json_value "$record" state)" \
    "$label rejection does not reserve or consume the predecessor"
}

missing_scope=runtime-resume-missing
missing_checkpoint=$(printf 1%.0s {1..64})
missing_hash=$(printf 2%.0s {1..64})
initialize_lineage "$missing_scope" run-parent-missing "$missing_hash" \
  "$missing_checkpoint" "$TEST_ROOT/missing-init.json"
reserve_runtime "$missing_scope" run-child-missing \
  >/dev/null 2>"$TEST_ROOT/missing.err"
assert_rc 78 "$?" "native resume fails closed when predecessor document is missing"
assert_advanced "$missing_scope" missing

mismatch_scope=runtime-resume-mismatch
mismatch_checkpoint=$(printf 3%.0s {1..64})
mismatch_doc="$usage_dir/run-parent-mismatch.json"
make_parent_document run-parent-mismatch runtime-resume-other runtime-resume-other \
  complete true "$mismatch_checkpoint" "$mismatch_doc"
mismatch_hash=$(sha256sum "$mismatch_doc" | awk '{print $1}')
initialize_lineage "$mismatch_scope" run-parent-mismatch "$mismatch_hash" \
  "$mismatch_checkpoint" "$TEST_ROOT/mismatch-init.json"
reserve_runtime "$mismatch_scope" run-child-mismatch \
  >/dev/null 2>"$TEST_ROOT/mismatch.err"
assert_rc 78 "$?" "native resume rejects predecessor bound to a different provider scope"
assert_advanced "$mismatch_scope" mismatch

partial_scope=runtime-resume-partial
partial_checkpoint=$(printf 4%.0s {1..64})
partial_doc="$usage_dir/run-parent-partial.json"
make_parent_document run-parent-partial "$partial_scope" "$partial_scope" \
  partial true "$partial_checkpoint" "$partial_doc"
partial_hash=$(sha256sum "$partial_doc" | awk '{print $1}')
initialize_lineage "$partial_scope" run-parent-partial "$partial_hash" \
  "$partial_checkpoint" "$TEST_ROOT/partial-init.json"
reserve_runtime "$partial_scope" run-child-partial \
  >/dev/null 2>"$TEST_ROOT/partial.err"
assert_rc 78 "$?" "native resume rejects a partial predecessor document"
assert_advanced "$partial_scope" partial

ineligible_scope=runtime-resume-ineligible
ineligible_checkpoint=$(printf 5%.0s {1..64})
ineligible_doc="$usage_dir/run-parent-ineligible.json"
make_parent_document run-parent-ineligible "$ineligible_scope" "$ineligible_scope" \
  complete false "$ineligible_checkpoint" "$ineligible_doc"
ineligible_hash=$(sha256sum "$ineligible_doc" | awk '{print $1}')
initialize_lineage "$ineligible_scope" run-parent-ineligible "$ineligible_hash" \
  "$ineligible_checkpoint" "$TEST_ROOT/ineligible-init.json"
reserve_runtime "$ineligible_scope" run-child-ineligible \
  >/dev/null 2>"$TEST_ROOT/ineligible.err"
assert_rc 78 "$?" "native resume rejects an ineligible predecessor checkpoint"
assert_advanced "$ineligible_scope" ineligible

eligible_scope=runtime-resume-eligible
eligible_checkpoint=$(printf 6%.0s {1..64})
eligible_doc="$usage_dir/run-parent-eligible.json"
make_parent_document run-parent-eligible "$eligible_scope" "$eligible_scope" \
  complete true "$eligible_checkpoint" "$eligible_doc"
eligible_hash=$(sha256sum "$eligible_doc" | awk '{print $1}')
initialize_lineage "$eligible_scope" run-parent-eligible "$eligible_hash" \
  "$eligible_checkpoint" "$TEST_ROOT/eligible-init.json"
reserve_runtime "$eligible_scope" run-child-eligible
assert_rc 0 "$?" "native resume reserves an exact complete scope-bound predecessor"
assert_eq true "$(printf '%s\n' "$RUNNER_LINEAGE_NORMALIZER_PARENT" \
  >"$TEST_ROOT/normalizer-parent.json"; json_value "$TEST_ROOT/normalizer-parent.json" resumeVerified)" \
  "normalizer receives a verified predecessor projection"
assert_eq 10 "$(json_value "$TEST_ROOT/normalizer-parent.json" \
  terminalCounterCheckpoint.vector.inputTokens)" \
  "verified predecessor projection contains the cumulative baseline"
printf '%s\n' "$RUNNER_LINEAGE_PARENT_REF" >"$TEST_ROOT/public-parent.json"
assert_eq "$eligible_hash" "$(json_value "$TEST_ROOT/public-parent.json" documentHash)" \
  "public parent reference keeps only immutable lineage hashes"

# Проверяем runtime-мост, работающий только через дескрипторы. Сырой счётчик resume
# вычитается из normalizerParentUsage, а опубликованный документ хранит публичную ссылку
# по хешу и никогда не содержит приватную проекцию baseline.
run_dir="$TEST_ROOT/resume-run"
mkdir -p -- "$run_dir"
chmod 700 -- "$run_dir"
events="$run_dir/events.jsonl"
printf '%s\n' \
  "{\"type\":\"thread.started\",\"thread_id\":\"$eligible_scope\"}" \
  '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":7,"cache_write_input_tokens":2,"output_tokens":8,"reasoning_output_tokens":3}}' \
  >"$events"
chmod 600 -- "$events"
run_dev=$(stat -c '%d' "$run_dir")
run_ino=$(stat -c '%i' "$run_dir")
events_dev=$(stat -c '%d' "$events")
events_ino=$(stat -c '%i' "$events")
context="$TEST_ROOT/resume-context.json"
runtime_analytics_json_v2 \
  identity.taskId string t91 \
  identity.attemptId string a_91919191919191919191919191919191 \
  identity.nodeVisitId string nv_11111111111111111111111111111111 \
  identity.nodeExecutionId string ne_22222222222222222222222222222222 \
  identity.dispatchId string d_33333333333333333333333333333333 \
  identity.runId string run-child-eligible identity.epoch integer 1 \
  provider string codex dialect string codex-jsonl-v1 \
  requestedModel string gpt-test resolvedModel string gpt-test \
  providerSessionMode string resume requestedProviderScope string "$eligible_scope" \
  parentUsageRef json "$RUNNER_LINEAGE_PARENT_REF" \
  normalizerParentUsage json "$RUNNER_LINEAGE_NORMALIZER_PARENT" \
  lineageGeneration integer "$RUNNER_LINEAGE_GENERATION" \
  startedAt string 2026-08-20T02:01:00.000Z \
  quiescedAt string 2026-08-20T02:02:00.000Z processComplete boolean true \
  runnerStartedEventHash string "$(printf e%.0s {1..64})" \
  usageDirectory string "$usage_dir" runDirectoryPath string "$run_dir" \
  runDirectoryIdentity.dev string "$run_dev" runDirectoryIdentity.ino string "$run_ino" \
  eventsIdentity.dev string "$events_dev" eventsIdentity.ino string "$events_ino" \
  >"$context"

exec {RUNNER_RUNTIME_EVENTS_READ_FD}<"$events"
exec {RUNNER_RUNTIME_EVENTS_WRITE_FD}>>"$events"
exec {RUNNER_RUNTIME_RUN_DIR_FD}<"$run_dir"
export RUNNER_RUNTIME_EVENTS_READ_FD RUNNER_RUNTIME_EVENTS_WRITE_FD RUNNER_RUNTIME_RUN_DIR_FD
prepared="$TEST_ROOT/resume-prepared.json"
_runner_runtime_usage_call prepare "$context" >"$prepared"
assert_rc 0 "$?" "runtime bridge normalizes resume from retained provider descriptors"
assert_eq complete "$(json_value "$prepared" normalization.completeness)" \
  "verified resume counter delta is complete"
assert_eq 6 "$(json_value "$prepared" normalization.tokenSummary.uncachedInput)" \
  "resume normalization subtracts the verified predecessor input baseline"
assert_eq 5 "$(json_value "$prepared" normalization.tokenSummary.output)" \
  "resume normalization subtracts the verified predecessor output baseline"
assert_eq '[]' "$(json_value "$prepared" normalization.diagnostics)" \
  "exact scope-bound resume has no counterScopeUnproven diagnostic"

publication="$TEST_ROOT/resume-publication.json"
_runner_runtime_usage_call publish "$context" "$prepared" >"$publication"
assert_rc 0 "$?" "resumed usage document publishes immutably"
child_doc="$usage_dir/run-child-eligible.json"
assert_eq "$eligible_hash" "$(json_value "$child_doc" parentUsageRef.documentHash)" \
  "published child retains the public predecessor document hash"
if json_value "$child_doc" normalizerParentUsage >/dev/null 2>&1; then
  test_fail "published child excludes the private normalizer predecessor projection"
else
  test_ok "published child excludes the private normalizer predecessor projection"
fi

exec {RUNNER_RUNTIME_EVENTS_READ_FD}<&-
exec {RUNNER_RUNTIME_EVENTS_WRITE_FD}>&-
exec {RUNNER_RUNTIME_RUN_DIR_FD}<&-
unset FACTORY_PROVIDER_SESSION_MODE FACTORY_PROVIDER_REQUESTED_SCOPE
finish_tests
