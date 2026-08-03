#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

helper="$FACTORY_PROFILES_DIR/arsenkin/hunt-evidence.py"
task=77
state="$TEST_ROOT/hunt-state"
control="$TEST_ROOT/hunt-control"
be="$TEST_ROOT/be"
fe="$TEST_ROOT/fe"
mkdir -p "$state" "$control" "$be" "$fe"

git -C "$be" init -q
git -C "$be" config user.name fixture
git -C "$be" config user.email fixture@example.test
git -C "$fe" init -q
git -C "$fe" config user.name fixture
git -C "$fe" config user.email fixture@example.test

files=(
  app/Auth/GuestGuard.php
  app/Http/Middleware/EnsureGuestLinkBelongsToUser.php
  app/Http/Middleware/AuthentificateGuardMiddleware.php
  app/Http/Middleware/CheckProjectPermissionMiddleware.php
  app/Domains/Projects/Actions/AuthorizeProjectPermissionAction.php
  app/Restify/Projects/Actions/Create.php
  app/Restify/Projects/Actions/Delete.php
  app/Restify/Projects/Actions/Update.php
  app/Restify/GuestLinks/Actions/Create.php
  app/Restify/GuestLinks/Actions/Delete.php
)
for file in "${files[@]}"; do
  mkdir -p "$be/$(dirname "$file")"
  printf '<?php // %s\n' "$file" >"$be/$file"
done
printf 'fixture\n' >"$fe/README.md"
git -C "$be" add .
git -C "$be" commit -qm baseline
git -C "$fe" add .
git -C "$fe" commit -qm baseline

common=(
  "$helper"
  --task "$task"
  --state-dir "$state"
  --backend "$be"
  --frontend "$fe"
  --control-dir "$control"
)

python3 "${common[@]}" scope >/dev/null
assert_rc 0 "$?" "hunt creates a bounded immutable scope"
assert_eq 10 "$(wc -l <"$state/t${task}.hunt-scope.tsv")" \
  "scope contains only the named fixture surface"
assert_eq 41 "$(wc -l <"$state/t${task}.hunt-matrix.tsv")" \
  "matrix is the exact scope by four-lens product plus header"

unit=backend:app/Auth/GuestGuard.php
python3 "${common[@]}" mark access checked "$unit" 'GuestGuard symbol read' >/dev/null
assert_rc 0 "$?" "one exact scope unit can be classified"

make_events() {
  local stage=$1 run_id=$2 payload=$3
  local directory="$state/logs/runs/t${task}/${stage}/${run_id}"
  mkdir -p "$directory"
  printf '%s\n' "$payload" >"$directory/events.jsonl"
}

make_events HUNT_ACCESS r-access \
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"$be/app/Auth/GuestGuard.php\"}}]}}"
python3 "${common[@]}" check-lens HUNT_ACCESS r-access done >/dev/null
assert_rc 0 "$?" "checked row is accepted when the exact run opened it"
assert_contains "$(cat "$state/t${task}.hunt-opened.access.tsv")" "$unit" \
  "host materializes the opened-path set"

other=backend:app/Restify/Projects/Actions/Create.php
python3 "${common[@]}" mark data checked "$other" 'claim without tool evidence' >/dev/null
make_events HUNT_DATA r-data-empty \
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"bash /tmp/hunt-evidence.sh mark $task data checked $other forged\"}}]}}"
python3 "${common[@]}" check-lens HUNT_DATA r-data-empty done >/dev/null 2>&1
assert_rc 78 "$?" "matrix mark command cannot impersonate source read evidence"

python3 "${common[@]}" mark data checked "$other" 'Codex shell read' >/dev/null
make_events HUNT_DATA r-data-codex \
  "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"/bin/bash -lc 'git show HEAD:app/Restify/Projects/Actions/Create.php'\",\"exit_code\":0}}"
python3 "${common[@]}" check-lens HUNT_DATA r-data-codex done >/dev/null
assert_rc 0 "$?" "Codex command_execution supplies the same trusted read evidence"

for lens in data errors race; do
  python3 "${common[@]}" mark-lens "$lens" 'not applicable' 'fixture lens is intentionally absent' >/dev/null
done
make_events HUNT_DATA r-data '{"type":"assistant","message":{"content":[]}}'
make_events HUNT_ERRORS r-errors '{"type":"assistant","message":{"content":[]}}'
make_events HUNT_RACE r-race '{"type":"assistant","message":{"content":[]}}'
python3 "${common[@]}" check-lens HUNT_DATA r-data skipped >/dev/null
assert_rc 0 "$?" "fully classified non-applicable data lens may skip"
python3 "${common[@]}" check-lens HUNT_ERRORS r-errors skipped >/dev/null
assert_rc 0 "$?" "fully classified non-applicable errors lens may skip"
python3 "${common[@]}" check-lens HUNT_RACE r-race skipped >/dev/null
assert_rc 0 "$?" "fully classified non-applicable race lens may skip"

# Provider-writable state — только витрина. Подмена копий не должна влиять на
# последующую проверку, которая читает оригиналы из trusted control-plane.
printf 'backend:app/Forged.php\n' >"$state/t${task}.hunt-opened.access.tsv"
printf '{"outcome":"done","scopeSha256":"forged"}\n' \
  >"$state/t${task}.hunt-check.access.json"

digest=$(awk '{print $1}' "$state/t${task}.hunt-scope.sha256")
printf '## Verification\nscope sha256: %s\n' "$digest" >"$state/t${task}.diag.md"
make_events VERIFY r-verify-fake \
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Write\",\"input\":{\"file_path\":\"$state/note.md\",\"content\":\"bash /home/evildev/Workspace/cockpit/profiles/arsenkin/stand-facts.sh $task\"}}]}}"
python3 "${common[@]}" check-verify r-verify-fake done >/dev/null 2>&1
assert_rc 78 "$?" "mentioning stand-facts in written text is not an invocation"

make_events VERIFY r-verify \
  "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"/bin/bash -lc 'bash /home/evildev/Workspace/cockpit/profiles/arsenkin/stand-facts.sh $task'\",\"exit_code\":0}}"

python3 "${common[@]}" check-verify r-verify done >/dev/null 2>&1
assert_rc 78 "$?" "calling stand-facts without preserving its output is rejected"
printf 'kind\tkey\tvalue1\tvalue2\tvalue3\nsandbox\ttask\t%s\tdb_t%s\tuser_t%s\n' \
  "$task" "$task" "$task" >>"$state/t${task}.diag.md"

python3 "${common[@]}" mark access 'not applicable' "$unit" 'late provider rewrite' >/dev/null
python3 "${common[@]}" check-verify r-verify done >/dev/null 2>&1
assert_rc 78 "$?" "later nodes cannot rewrite a trusted lens snapshot"
python3 "${common[@]}" mark access checked "$unit" 'GuestGuard symbol read' >/dev/null

python3 "${common[@]}" check-verify r-verify done >/dev/null
assert_rc 0 "$?" "mandatory verify proves stand facts and scope hash"

printf '%s\n' \
  '# Hunt report' \
  '## Confirmed findings' \
  'none' \
  '## Unverified leads' \
  'none' \
  '## Duplicates' \
  'none' \
  '## Not checked' \
  'recorded in matrix' \
  '## Coverage' \
  "scope sha256: $digest" \
  >"$state/t${task}.report.md"
make_events TRIAGE r-triage \
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"$state/t${task}.hunt-matrix.tsv\"}}]}}"
python3 "${common[@]}" check-triage r-triage done >/dev/null
assert_rc 0 "$?" "triage accepts a zero-findings report with complete evidence"

printf 'backend:app/Forged.php\n' >>"$state/t${task}.hunt-scope.tsv"
python3 "${common[@]}" check-triage r-triage done >/dev/null 2>&1
assert_rc 78 "$?" "tampered scope is rejected by its host-side hash"

finish_tests
