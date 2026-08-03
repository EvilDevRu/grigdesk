#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

profiles="$TEST_ROOT/profiles"
mkdir -p "$profiles/fixture"

cat >"$profiles/fixture/profile.sh" <<'PROFILE'
#!/usr/bin/env bash
PROFILE_NAME=fixture
PROFILE_SERVICE_HOST=127.0.0.1

profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() { printf 'fixture\t/tmp/fixture\t/tmp/fixture\n'; }
profile_project_context() { printf '{"stack":["fixture"],"guardrails":[]}\n'; }
profile_source_branch() { printf 'main\n'; }
profile_container() { printf 'fixture\n'; }
profile_stand_alive() { return 0; }
profile_service_ports() { printf '8080\t8081\n'; }
profile_exclusive_resources() {
  printf '%s\n' 'workspace:/tmp/fixture' 'stand:fixture'
}
profile_instrumentation_restored() { return 0; }

# Ядовитые определения старого контракта: factory-check не имеет права их читать.
PROFILE_ROUTE_STAGES_dev=(BUILD)
profile_stage_prompt() { exit 97; }
profile_stage_fanout() { exit 97; }
PROFILE
cat >"$profiles/fixture/runners.env" <<'RUNNERS'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=codex
PROJECT_RUNNER_FAILOVER=
RUNNERS
cat >"$profiles/fixture/graph.json" <<'GRAPH'
{"capabilities":["route-v2"]}
GRAPH

run_check() {
  FACTORY_PROFILES_DIR="$profiles" \
    "$FACTORY_HOME/bin/factory-check" fixture --quick >"$TEST_ROOT/check-contract.out" 2>&1
}

run_check
assert_rc 0 "$?" "single-route profile passes factory-check"
output=$(<"$TEST_ROOT/check-contract.out")
assert_contains "$output" "capability заявлена" "factory-check validates route capability/hooks"
assert_contains "$output" "canonical config" "factory-check validates runner config"
assert_contains "$output" "хост стенда" "factory-check validates service host"
if [[ "$output" == *"промпт"* || "$output" == *"PROFILE_ROUTE_STAGES"* ||
      "$output" == *"fanout"* || "$output" == *"веер"* ]]; then
  test_fail "factory-check ignores legacy route arrays/prompts/fanout" "$output"
else
  test_ok "factory-check ignores legacy route arrays/prompts/fanout"
fi

python3 - "$profiles/fixture/graph.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    graph = json.load(source)
graph["capabilities"] = []
with open(sys.argv[1], "w", encoding="utf-8") as target:
    json.dump(graph, target)
PY
run_check
assert_rc 1 "$?" "profile without route capability fails closed"
assert_contains "$(<"$TEST_ROOT/check-contract.out")" "запуск fail-closed" \
  "missing capability has explicit diagnostic"

# Профиль, который задач не ведёт (triage-конфигурация кокпита), заявляет это вслух.
# Без этого проверка требовала route-контракт от каждого каталога в profiles/ и общий
# код возврата не мог стать нулём никогда — красную проверку перестают читать.
printf '%s\n' '{"capabilities":[],"launchable":false}' >"$profiles/fixture/graph.json"
run_check
assert_rc 0 "$?" "profile declaring launchable:false passes without route contract"
output=$(<"$TEST_ROOT/check-contract.out")
assert_contains "$output" "задач не ведёт" "non-launchable profile is named, not diagnosed"
if [[ "$output" == *"capability заявлена"* || "$output" == *"хост стенда"* ||
      "$output" == *"canonical config"* ]]; then
  test_fail "launch checks are skipped for non-launchable profile" "$output"
else
  test_ok "launch checks are skipped for non-launchable profile"
fi

# Заявить и то и другое — расхождение опаснее любого из двух состояний: движок поле
# не читает, прогон пойдёт, а route и стенд останутся непроверенными.
printf '%s\n' '{"capabilities":["route-v2"],"launchable":false}' >"$profiles/fixture/graph.json"
run_check
assert_rc 1 "$?" "launchable:false together with route-v2 capability fails closed"
assert_contains "$(<"$TEST_ROOT/check-contract.out")" "оставь что-то одно" \
  "contradiction between capability and launchable is named"

printf '%s\n' '{"capabilities":["route-v2"]}' >"$profiles/fixture/graph.json"
sed -i '/profile_instrumentation_restored/d' "$profiles/fixture/profile.sh"
run_check
assert_rc 1 "$?" "shared profile without restore hook is rejected"
assert_contains "$(<"$TEST_ROOT/check-contract.out")" "profile_instrumentation_restored" \
  "missing shared hook is named"

sed -i '/PROFILE_SERVICE_HOST=/c\PROFILE_SERVICE_HOST=http://127.0.0.1:8080' \
  "$profiles/fixture/profile.sh"
run_check
assert_rc 1 "$?" "service host with scheme and port is rejected"
assert_contains "$(<"$TEST_ROOT/check-contract.out")" "нужно голое имя хоста" \
  "invalid service host has explicit diagnostic"

finish_tests
