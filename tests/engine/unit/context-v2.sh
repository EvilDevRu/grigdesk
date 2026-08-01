#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

tool="$FACTORY_HOME/bin/factory-context-v2"
root="$TEST_ROOT/work/context"
be_source="$root/be-source"
fe_source="$root/fe-source"
be_worktree="$root/be-worktree"
fe_worktree="$root/fe-worktree"
state="$root/state"
mkdir -p \
  "$be_source" "$fe_source" \
  "$be_worktree/app" "$fe_worktree/src" \
  "$state"

ticket="$root/ticket.json"
cat >"$ticket" <<'JSON'
{
  "schema": 1,
  "taskId": "8166",
  "title": "Проверить вычисления",
  "description": "Исправить расчёт и доказать корректность трассировкой.",
  "acceptanceCriteria": [
    "Расчёт совпадает с ожидаемым",
    "Временная инструментация удалена"
  ],
  "sourceUrl": "https://portal.example.test/tasks/8166"
}
JSON

attempt="a_11111111111111111111111111111111"
catalog="$(printf 'a%.0s' {1..64})"
route_hash="$(printf 'b%.0s' {1..64})"
scope="$state/t8166.instrumentation-scope.list"
allowed="$be_worktree/app/Calculation.php"
printf '%s\n' "$allowed" >"$scope"

common=(
  --task 8166
  --profile arsenkin
  --attempt "$attempt"
  --catalog-hash "$catalog"
  --route feature
  --route-hash "$route_hash"
  --node trace
  --run-key TRACE
  --ticket-json "$ticket"
  --backend-source "$be_source"
  --frontend-source "$fe_source"
  --backend-worktree "$be_worktree"
  --frontend-worktree "$fe_worktree"
  --state-dir "$state"
  --sandbox-generation v2
  --container-name ars-sb-t8166-application-1
  --frontend-port 5192
  --api-port 8092
  --allowed-file "$allowed"
  --scope-file "$scope"
  --transaction-id "v2-11111111111111111111111111111111-s5"
  --instrumentation-phase active
  --instrumentation-required
  --event-count 5
  --cause-decision approved
  --review-decision approved
  --acceptance-decision approved
  --delivery-mode publish
  --delivery-action commit
  --delivery-action push
  --delivery-action pull-request
  --delivery-target be=master
  --delivery-target fe=main
  --source-branch task-8166-v2
)

output=$("$tool" "${common[@]}")
assert_rc 0 "$?" "provider-neutral typed context is built"
assert_eq "8166" "$(jq -r '.task.id' <<<"$output")" \
  "context keeps the task id as data"
assert_eq v2 "$(jq -r '.workspace.generation' <<<"$output")" \
  "context identifies the fresh sandbox generation"
assert_eq "$allowed" "$(jq -r '.instrumentation.allowedFiles[0]' <<<"$output")" \
  "context includes the trusted transaction scope"
assert_eq FACTORY-TRACE:t8166 "$(jq -r '.instrumentation.marker' <<<"$output")" \
  "marker is engine-owned rather than provider-owned"
assert_eq publish "$(jq -r '.delivery.mode' <<<"$output")" \
  "normal v2 delivery is enabled"
assert_eq approved "$(jq -r '.decisions.acceptance.status' <<<"$output")" \
  "accepted gate is represented as typed data"
assert_eq task-8166-v2 "$(jq -r '.delivery.sourceBranch' <<<"$output")" \
  "SHIP receives the exact source branch"
assert_eq "http://127.0.0.1:5192" "$(jq -r '.services.frontendUrl' <<<"$output")" \
  "validated port becomes a local service URL"

without_push=()
skip_next=0
for value in "${common[@]}"; do
  if (( skip_next == 1 )); then
    skip_next=0
    continue
  fi
  if [[ "$value" == --delivery-action ]]; then
    skip_next=1
    continue
  fi
  without_push+=("$value")
done
"$tool" "${without_push[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "publish refuses a delivery contract without required actions"

bad_branch=("${common[@]}")
bad_branch[${#bad_branch[@]}-1]='task-8166..escape'
"$tool" "${bad_branch[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "unsafe source branch is rejected"

jq '.unexpected = true' "$ticket" >"$root/ticket-extra.json"
bad_ticket=("${common[@]}")
for index in "${!bad_ticket[@]}"; do
  [[ "${bad_ticket[$index]}" == "$ticket" ]] &&
    bad_ticket[$index]="$root/ticket-extra.json"
done
"$tool" "${bad_ticket[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "ticket cannot inject an unknown context field"

outside=("${common[@]}")
for index in "${!outside[@]}"; do
  [[ "${outside[$index]}" == "$allowed" ]] &&
    outside[$index]="$root/outside.php"
done
"$tool" "${outside[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "transaction scope cannot escape the task worktrees"

finish_tests
