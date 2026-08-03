#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# Task-level override исполнителя через factory start --runner-primary: CLI
# валидирует id (формат и наличие адаптера) и фиксирует override в реестре
# задачи до начала оркестрации. Фейки исполнителей — tests/engine/fakes/runners
# (alpha/beta стоят здесь за project primary/failover профиля).
tool="$FACTORY_HOME/bin/factory"
routes="$TEST_ROOT/routes"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs"
profile_id=demo-profile
fixture_task=9201

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
profile_dir="$FACTORY_PROFILES_DIR/$profile_id"
mkdir -p "$profile_dir"
printf '%s\n' \
  RUNNERS_SCHEMA=1 \
  CONFIG_REVISION=1 \
  RUNNERS_COVERAGE=required \
  PROJECT_RUNNER_PRIMARY=alpha \
  PROJECT_RUNNER_FAILOVER=beta \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture \
  MODEL_DEFAULT_ALPHA_VERSION=latest \
  MODEL_DEFAULT_BETA_FAMILY=fixture \
  MODEL_DEFAULT_BETA_VERSION=latest \
  >"$profile_dir/runners.env"
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"

# Shared checkout — локальный fixture без контейнеров и внешних процессов,
# как в contract/factory-launcher.sh: live-запрет снимается точечно.
shared_repo="$TEST_ROOT/shared-checkout"
mkdir -p "$shared_repo"
git -C "$shared_repo" init -q
git -C "$shared_repo" config user.name fixture
git -C "$shared_repo" config user.email fixture@example.test
git -C "$shared_repo" checkout -qb shared-main
printf 'baseline\n' >"$shared_repo/tracked.txt"
git -C "$shared_repo" add tracked.txt
git -C "$shared_repo" commit -qm baseline

cat >"$profile_dir/profile.sh" <<PROFILE
PROFILE_NAME=$profile_id
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' '$shared_repo' '$shared_repo'; }
profile_source_branch() { printf 'shared-main\\n'; }
profile_container() { printf 'fixture-stand\\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\\t8830\\n'; }
profile_exclusive_resources() {
  printf '%s\\n' 'stand:fixture-stand' 'workspace:$shared_repo'
}
PROFILE

"$NODE_BIN" "$publisher" "$routes" null >/dev/null
assert_rc 0 "$?" "route catalog publishes for runner override"

ticket="$TEST_ROOT/ticket.json"
cat >"$ticket" <<JSON
{
  "schema": 1,
  "taskId": "$fixture_task",
  "title": "runner override",
  "description": "task-level primary override",
  "acceptanceCriteria": ["override recorded in the task registry"],
  "sourceUrl": "https://portal.example.test/fixtures/$fixture_task"
}
JSON

start_args=(
  "$fixture_task" start --profile "$profile_id"
  --route feature
  --ticket-json "$ticket"
  --delivery-target app=main
  --routes-dir "$routes"
)

run_start() {
  local name=$1; shift
  FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    "$tool" "${start_args[@]}" "$@" \
    --state-dir "$TEST_ROOT/state-$name" \
    --control-dir "$TEST_ROOT/control-$name"
}

# 1. Неустановленный адаптер отклоняется до создания состояния задачи.
bogus_error=$(run_start bogus --runner-primary bogus 2>&1)
assert_rc 78 "$?" "start --runner-primary с неустановленным адаптером отклонён"
assert_contains "$bogus_error" 'исполнитель не установлен' \
  "отказ называет неустановленный id исполнителя"
assert_file_missing "$TEST_ROOT/state-bogus" \
  "отклонённый start не создаёт state каталог"

# 2. Идентификатор обязан быть допустимым именем адаптера.
bad_format=$(run_start bad-format --runner-primary 'Bogus!' 2>&1)
assert_rc 78 "$?" "start --runner-primary с недопустимым id отклонён"
assert_contains "$bad_format" 'недопустимый id исполнителя' \
  "отказ называет формат id исполнителя"
assert_file_missing "$TEST_ROOT/state-bad-format" \
  "отклонённый по формату start не создаёт state каталог"

# 3. Флаг допустим только при start: resume ведёт immutable попытку.
resume_error=$(FACTORY_FORBID_LIVE=0 "$tool" "$fixture_task" resume \
  --profile "$profile_id" \
  --attempt a_92019201920192019201920192019201 \
  --runner-primary alpha \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/state-resume" \
  --control-dir "$TEST_ROOT/control-resume" 2>&1)
assert_rc 78 "$?" "--runner-primary отклонён в режиме resume"
assert_contains "$resume_error" 'допустим только при start' \
  "отказ объясняет режимную границу флага"
assert_file_missing "$TEST_ROOT/state-resume" \
  "отклонённый resume не создаёт state каталог"

# 4. Override на failover-адаптер: выбранный id уходит из failover-цепочки.
beta_out=$(run_start beta --runner-primary beta 2>&1)
beta_rc=$?
if (( beta_rc != 0 )); then test_note "start --runner-primary beta: $beta_out"; fi
assert_rc 0 "$beta_rc" "start с --runner-primary beta доходит до human gate"
beta_registry="$TEST_ROOT/state-beta/t${fixture_task}.pipeline"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$beta_registry")" \
  "прогон с override реально стартовал и встал на воротах"
assert_eq beta "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$beta_registry")" \
  "override primary зафиксирован в реестре задачи"
assert_eq "" "$(awk -F= '$1=="RUNNER_OVERRIDE_FAILOVER"{print $2}' "$beta_registry")" \
  "выбранный id убран из failover-цепочки"
grep -q '^RUNNER_OVERRIDE_FAILOVER=' "$beta_registry"
assert_rc 0 "$?" "пустой failover записан явно, профильный не подмешивается"

# 5. Override на project primary: failover профиля сохраняется без выбранного id.
alpha_out=$(run_start alpha --runner-primary alpha 2>&1)
alpha_rc=$?
if (( alpha_rc != 0 )); then test_note "start --runner-primary alpha: $alpha_out"; fi
assert_rc 0 "$alpha_rc" "start с --runner-primary alpha доходит до human gate"
alpha_registry="$TEST_ROOT/state-alpha/t${fixture_task}.pipeline"
assert_eq alpha "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$alpha_registry")" \
  "override primary alpha зафиксирован в реестре"
assert_eq beta "$(awk -F= '$1=="RUNNER_OVERRIDE_FAILOVER"{print $2}' "$alpha_registry")" \
  "failover профиля перенесён в override без выбранного id"

# 6. Без флага реестр не получает override-ключей: цепочка живёт в runners.env.
default_out=$(run_start default 2>&1)
default_rc=$?
if (( default_rc != 0 )); then test_note "start без override: $default_out"; fi
assert_rc 0 "$default_rc" "start без --runner-primary доходит до human gate"
default_registry="$TEST_ROOT/state-default/t${fixture_task}.pipeline"
if grep -q '^RUNNER_OVERRIDE_' "$default_registry"; then
  test_fail "без --runner-primary реестр не содержит override-ключей" \
    "$(cat "$default_registry")"
else
  test_ok "без --runner-primary реестр не содержит override-ключей"
fi

finish_tests
