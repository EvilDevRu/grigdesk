#!/usr/bin/env bash
# Остановка этапа GLM по сроку: настоящий раннер и launcher, metadata — настоящий helper.
# Вместо wrapper-а — fixture-процесс со стойким потомком: проверяется дерево сессии,
# а не модельный ход (его закрывают проверки собранного ELF).
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

runner="$FACTORY_HOME/lib/runners/glm.sh"
if [[ ! -f "$runner" ]]; then
  test_fail "GLM stop contract has a runner" "missing $runner"
  finish_tests
  exit $?
fi

task=146
stage=CHECK
run_id=run-glm-timeout
run_dir="$STATE_DIR/logs/runs/t${task}/${stage}/${run_id}"
pipeline_store_route_init "$task" "$stage"
factory_control_init control-secret
run_state_begin "$task" "$stage" "$run_id" 1 stop-token

mkdir -p "$TEST_ROOT/bin"
fake_bin="$TEST_ROOT/bin/dsh-glm"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeGlmBinary.mts" >"$fake_bin"
chmod +x "$fake_bin"

# Node поставки DSH: metadata и разбор descriptor исполняет настоящий Node, а wrapper
# заменён процессом, который как настоящий завершается по TERM без result, но оставляет
# потомка, игнорирующего TERM.
marker="glm-stubborn-${RANDOM}-${RANDOM}"
fake_node="$TEST_ROOT/bin/node-dsh"
cat >"$fake_node" <<BASH
#!/usr/bin/env bash
case "\${1:-}" in
  */glmRunner.mts)
    printf '%s\n' '{"event":"glm_start","mode":"workspace-write","model":"[\\"zai\\",\\"glm-5.3\\"]"}'
    bash -c 'trap "" TERM; exec -a "\$1" sleep 60' fixture "$marker" &
    trap 'exit 143' TERM
    while :; do sleep 0.1; done
    ;;
esac
exec "$NODE_BIN" "\$@"
BASH
chmod +x "$fake_node"

export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export GRIGDESK_DEEPSEEK_NODE_BIN="$fake_node"
export GRIGDESK_DEEPSEEK_CACHE_DIR="$TEST_ROOT/dsh-cache"
export GRIGDESK_GLM_API_MODE=api
export ZAI_API_KEY=synthetic-glm-factory-key
export FACTORY_FORBID_LIVE=0
export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
runner_registry_reset
runner_registry_add glm "$runner"

runner_launch glm "$task" "wait until stopped" "$stage" '["zai","glm-5.3"]' high 1 \
  "$run_dir" "$run_id" 1 stop-token >/dev/null 2>&1
assert_rc 124 "$?" "timeout различим после остановки wrapper-а"

alive=1
for _poll in {1..200}; do
  if ! pgrep -f "^${marker}( |$)" >/dev/null 2>&1; then
    alive=0
    break
  fi
  sleep 0.02
done
if [[ "$alive" == 0 ]]; then
  test_ok "стойкий потомок wrapper-а не переживает quiescence сессии"
else
  test_fail "стойкий потомок wrapper-а не переживает quiescence сессии" "$marker is alive"
  pkill -KILL -f "^${marker}( |$)" 2>/dev/null || true
fi
assert_contains "$(cat "$run_dir/events.jsonl")" '"event":"glm_start"' \
  "поток wrapper-а сохранён в retained events"
if grep -Fq '"event":"result"' "$run_dir/events.jsonl" 2>/dev/null; then
  test_fail "остановленный ход не сохраняется успешным result" "result event found after timeout"
else
  test_ok "остановленный ход не сохраняется успешным result"
fi
assert_eq timeout "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
  "классификатор GLM отдаёт timeout"
if grep -Fq synthetic-glm-factory-key "$run_dir"/* 2>/dev/null; then
  test_fail "ключ GLM не попадает в артефакты прогона" "key leaked into $run_dir"
else
  test_ok "ключ GLM не попадает в артефакты прогона"
fi

finish_tests
