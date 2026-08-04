#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

tool="$FACTORY_HOME/bin/factory-context"
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
  "taskId": "42",
  "title": "Проверить вычисления",
  "description": "Исправить расчёт и доказать корректность трассировкой.",
  "acceptanceCriteria": [
    "Расчёт совпадает с ожидаемым",
    "Временная инструментация удалена"
  ],
  "sourceUrl": "https://portal.example.test/tasks/42"
}
JSON

attempt="a_11111111111111111111111111111111"
catalog="$(printf 'a%.0s' {1..64})"
route_hash="$(printf 'b%.0s' {1..64})"
scope="$state/t42.instrumentation-scope.list"
allowed="$be_worktree/app/Calculation.php"
printf '%s\n' "$allowed" >"$scope"
project_context='{"stack":["PHP 8.4","Vue 3"],"guardrails":["Не применять auto-fix."]}'
findings_ledger='{"schema":1,"open":[{"id":"valid-regex-route","sourceNode":"review","owner":"build","summary":"валидный regex возвращает 422","openedSequence":4,"lastSeenSequence":6,"status":"open","closedSequence":null}],"closed":[]}'

common=(
  --task 42
  --profile demo-profile
  --attempt "$attempt"
  --catalog-hash "$catalog"
  --route feature
  --route-hash "$route_hash"
  --node trace
  --run-key TRACE
  --ticket-json "$ticket"
  --project-context-json "$project_context"
  --backend-source "$be_source"
  --frontend-source "$fe_source"
  --backend-worktree "$be_worktree"
  --frontend-worktree "$fe_worktree"
  --state-dir "$state"
  --workspace-mode isolated
  --container-name demo-sb-t42-application-1
  --frontend-port 5192
  --api-port 8092
  --allowed-file "$allowed"
  --scope-file "$scope"
  --transaction-id "v2-11111111111111111111111111111111-s5"
  --instrumentation-phase active
  --instrumentation-required
  --event-count 5
  --findings-ledger-json "$findings_ledger"
  --cause-decision approved
  --review-decision approved
  --acceptance-decision approved
  --delivery-mode publish
  --delivery-action commit
  --delivery-action push
  --delivery-action pull-request
  --delivery-target be=master
  --delivery-target fe=main
  --source-branch task-42
)

output=$("$tool" "${common[@]}")
assert_rc 0 "$?" "provider-neutral typed context is built"
assert_eq "42" "$(jq -r '.task.id' <<<"$output")" \
  "context keeps the task id as data"
assert_eq isolated "$(jq -r '.workspace.mode' <<<"$output")" \
  "context records the exact workspace mode"
assert_eq "$allowed" "$(jq -r '.instrumentation.allowedFiles[0]' <<<"$output")" \
  "context includes the trusted transaction scope"
assert_eq FACTORY-TRACE:t42 "$(jq -r '.instrumentation.marker' <<<"$output")" \
  "marker is engine-owned rather than provider-owned"
assert_eq publish "$(jq -r '.delivery.mode' <<<"$output")" \
  "normal v2 delivery is enabled"
assert_eq approved "$(jq -r '.decisions.acceptance.status' <<<"$output")" \
  "accepted gate is represented as typed data"
assert_eq task-42 "$(jq -r '.delivery.sourceBranch' <<<"$output")" \
  "SHIP receives the exact source branch"
assert_eq "http://127.0.0.1:5192" "$(jq -r '.services.frontendUrl' <<<"$output")" \
  "validated port becomes a local service URL"
assert_eq 'PHP 8.4,Vue 3' "$(jq -r '.project.stack | join(",")' <<<"$output")" \
  "project stack comes from the profile-owned context"
assert_eq 'Не применять auto-fix.' "$(jq -r '.project.guardrails[0]' <<<"$output")" \
  "project guardrails are not hardcoded by the engine"
assert_eq valid-regex-route "$(jq -r '.evidence.findings.open[0].id' <<<"$output")" \
  "typed context carries the open finding from the verified attempt ledger"
assert_eq build "$(jq -r '.evidence.findings.open[0].owner' <<<"$output")" \
  "finding ownership remains typed data for the receiving node"

bad_findings=("${common[@]}")
for index in "${!bad_findings[@]}"; do
  [[ "${bad_findings[$index]}" == "$findings_ledger" ]] &&
    bad_findings[$index]='{"schema":1,"open":[{"id":"valid-regex-route","sourceNode":"review","owner":"reviewer","summary":"неизвестный owner","openedSequence":4,"lastSeenSequence":6,"status":"open","closedSequence":null}],"closed":[]}'
done
"$tool" "${bad_findings[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "findings projection rejects an owner outside the closed contract"

unknown_delivery=("${common[@]}")
for index in "${!unknown_delivery[@]}"; do
  [[ "${unknown_delivery[$index]}" == be=master ]] &&
    unknown_delivery[$index]=ghost=master
done
"$tool" "${unknown_delivery[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "delivery target must name a repository from the workspace"

# Хост стенда объявляет профиль: приложение может отличать локальный запуск от прода
# по имени хоста, и петлевой адрес тогда открывает не тот же стенд, а другой режим.
named_host=("${common[@]}" --service-host localhost)
named_output=$("$tool" "${named_host[@]}")
assert_rc 0 "$?" "declared service host is accepted"
assert_eq "http://localhost:5192" "$(jq -r '.services.frontendUrl' <<<"$named_output")" \
  "profile-declared host reaches the browser stage"
assert_eq "http://localhost:8092" "$(jq -r '.services.apiUrl' <<<"$named_output")" \
  "api url follows the same declared host"

# Схему и порт подставляет движок, поэтому в значении их быть не может: иначе агент
# получит неоткрываемый адрес и узнает об этом, уже стоя перед мёртвой страницей.
for bad_host in "http://localhost" "localhost:5192" "local host" "локалхост" ""; do
  "$tool" "${common[@]}" --service-host "$bad_host" >/dev/null 2>&1
  assert_rc 78 "$?" "service host rejects «$bad_host»"
done

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
bad_branch[${#bad_branch[@]}-1]='task-42..escape'
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

# Однорепозиторный профиль не обязан выдумывать frontend-worktree: typed context
# хранит ровно объявленный repo и проектную метаинформацию.
single_source="$root/rdesigner-source"
single_worktree="$root/rdesigner-worktree"
mkdir -p "$single_source" "$single_worktree/webapp"
single=(
  --task 42
  --profile rdesigner
  --attempt "$attempt"
  --catalog-hash "$catalog"
  --route feature
  --route-hash "$route_hash"
  --node browser
  --run-key BROWSER
  --ticket-json "$ticket"
  --project-context-json '{"stack":["Python 3.11","Three.js"],"guardrails":["Одна GPU; рендеры только последовательно."]}'
  --repo "rdesigner:$single_worktree:$single_source:factory/t42"
  --state-dir "$state"
  --workspace-mode shared
  --container-name rdesigner-t42
  --frontend-port 8831
  --api-port 8831
  --delivery-mode disabled
  --source-branch factory/t42
)
single_output=$("$tool" "${single[@]}")
assert_rc 0 "$?" "single-repository typed context is built"
assert_eq '["rdesigner"]' "$(jq -c '.workspace.repos' <<<"$single_output")" \
  "workspace preserves the exact repository list"
assert_eq "$single_worktree" "$(jq -r '.workspace.rdesigner.path' <<<"$single_output")" \
  "single repository keeps its declared worktree"
assert_eq false "$(jq 'has("backend") or has("frontend")' <<<"$(jq '.workspace' <<<"$single_output")")" \
  "single repository context has no synthetic backend/frontend"
assert_eq 'Python 3.11,Three.js' "$(jq -r '.project.stack | join(",")' <<<"$single_output")" \
  "single repository keeps ordered project metadata"

bad_project=("${single[@]}")
for index in "${!bad_project[@]}"; do
  [[ "${bad_project[$index]}" == *'"Python 3.11"'* ]] &&
    bad_project[$index]='{"stack":["Python"],"guardrails":[],"unexpected":true}'
done
"$tool" "${bad_project[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "project context rejects unknown fields"

"$tool" "${single[@]}" \
  --repo "rdesigner:$single_worktree:$single_source:factory/t42" >/dev/null 2>&1
assert_rc 78 "$?" "single repository context rejects a duplicate repo"

reserved=("${single[@]}")
for index in "${!reserved[@]}"; do
  [[ "${reserved[$index]}" == "rdesigner:$single_worktree:$single_source:factory/t42" ]] &&
    reserved[$index]="generation:$single_worktree:$single_source:factory/t42"
done
"$tool" "${reserved[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "repository name cannot overwrite typed workspace metadata"

# Ветка своя у каждого репозитория: агент обязан видеть ветку СВОЕГО checkout, иначе
# в проекте из нескольких репозиториев с разными канонами он читает чужую.
assert_eq 'factory/t42' "$(jq -r '.workspace.rdesigner.branch' <<<"$single_output")" \
  "repository carries its own pinned branch"

short_repo=("${single[@]}")
for index in "${!short_repo[@]}"; do
  [[ "${short_repo[$index]}" == "rdesigner:$single_worktree:$single_source:factory/t42" ]] &&
    short_repo[$index]="rdesigner:$single_worktree:$single_source"
done
short_output=$("$tool" "${short_repo[@]}")
assert_rc 0 "$?" "legacy launcher repo survives a rolling context-builder update"
assert_eq 'factory/t42' "$(jq -r '.workspace.rdesigner.branch' <<<"$short_output")" \
  "legacy repo inherits the explicitly pinned common source branch"

bad_branch=("${single[@]}")
for index in "${!bad_branch[@]}"; do
  [[ "${bad_branch[$index]}" == "rdesigner:$single_worktree:$single_source:factory/t42" ]] &&
    bad_branch[$index]="rdesigner:$single_worktree:$single_source:../evil"
done
"$tool" "${bad_branch[@]}" >/dev/null 2>&1
assert_rc 78 "$?" "repository branch name is validated like any other branch"

finish_tests
