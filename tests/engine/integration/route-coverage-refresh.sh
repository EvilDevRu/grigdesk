#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_RUNNERS_DIR="$TEST_ROOT/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_RUNNERS_DIR" "$FACTORY_PROFILES_DIR/fixture" "$TEST_ROOT/work"
cp "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh" "$FACTORY_RUNNERS_DIR/alpha.sh"
cp "$FACTORY_TESTS_HOME/fakes/runners/beta.sh" "$FACTORY_RUNNERS_DIR/beta.sh"

cat >>"$FACTORY_RUNNERS_DIR/alpha.sh" <<'RUNNER'

# Проба отмечает только обращение к metadata, отдельно от запуска агента.
# Управляемые сбои проверяют срок и гонку конфигурации без настоящего CLI.
runner_alpha_probe() {
  printf 'alpha\n' >>"$TEST_ROOT/probes"
  [[ -z "${FAKE_CONFIG_CHANGE:-}" ]] ||
    sed -i 's/CONFIG_REVISION=1/CONFIG_REVISION=2/' "$FAKE_CONFIG_CHANGE"
  [[ -z "${FAKE_PROBE_DELAY:-}" ]] || sleep "$FAKE_PROBE_DELAY"
  if [[ "${FAKE_ALPHA_PROBE:-}" == incompatible ]]; then
    printf 'RUNNER_SUPPLY_INCOMPATIBLE=alpha\n' >&2
    return 4
  fi
  [[ "${FAKE_ALPHA_PROBE:-ready}" == ready ]] || return 4
  printf 'ready\n'
}

# Снятая модель должна блокировать обновление даже при доступном CLI.
# Метод run в этом случае вызываться не должен.
runner_alpha_catalog() {
  [[ "${FAKE_CATALOG_MISSING:-0}" == 0 ]] || return 4
  printf 'alpha-model\talpha\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}
RUNNER

cat >>"$FACTORY_RUNNERS_DIR/beta.sh" <<'RUNNER'

# Резерв проверяется при обновлении покрытия всего профиля.
# Журнал позволяет отличить новый preflight от чтения свежего снимка.
runner_beta_probe() {
  printf 'beta\n' >>"$TEST_ROOT/probes"
  if [[ "${FAKE_BETA_PROBE:-}" == incompatible ]]; then
    printf 'RUNNER_SUPPLY_INCOMPATIBLE=beta\n' >&2
    return 4
  fi
  [[ "${FAKE_BETA_PROBE:-ready}" == ready ]] || return 4
  printf 'ready\n'
}
RUNNER

config="$FACTORY_PROFILES_DIR/fixture/runners.env"
cat >"$config" <<'CONFIG'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=beta
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
MODEL_DEFAULT_BETA_FAMILY=fixture
MODEL_DEFAULT_BETA_VERSION=latest
CONFIG

PROFILE_NAME=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"
PROFILE_AGENT_DIRS="$TEST_ROOT/work"
source "$FACTORY_HOME/lib/core.sh"
source "$FACTORY_HOME/lib/profile-preflight.sh"
export FAKE_ALPHA_RESULT=done

profile_runner_host_preflight fixture 100 60
assert_rc 0 "$?" "исходный preflight проходит без model call"
coverage="$STATE_DIR/coverage/fixture"
cp "$coverage/host.env" "$TEST_ROOT/host-valid.env"
cp "$coverage/structural.env" "$TEST_ROOT/structural-valid.env"
cp "$config" "$TEST_ROOT/config-valid.env"

# Каждый случай начинает с настоящего положительного, но просроченного снимка.
# Реестры задач разные; изменения одного исхода не подсказывают следующий.
restore_coverage() {
  cp "$TEST_ROOT/host-valid.env" "$coverage/host.env"
  cp "$TEST_ROOT/structural-valid.env" "$coverage/structural.env"
  cp "$TEST_ROOT/config-valid.env" "$config"
  : >"$TEST_ROOT/invocations"
  : >"$TEST_ROOT/probes"
  unset FAKE_ALPHA_PROBE FAKE_BETA_PROBE FAKE_CONFIG_CHANGE FAKE_CATALOG_MISSING
  unset FAKE_PROBE_DELAY FACTORY_HOST_PREFLIGHT_TTL
}

# Вызывается обычный путь запуска узла, а не только функция обновления.
# Отдельно сохраняются код возврата и журнал, чтобы проверить барьер до run.
run_fixture() {
  local task=$1
  pipeline_store_route_init "$task" BUILD PROFILE fixture STALLED_HUMAN 0 \
    RUNNER_OVERRIDE_STAGE_BUILD "${2:-}"
  run_agent "$task" 'проверка продолжения после срока preflight' BUILD \
    >"$TEST_ROOT/task-$task.log" 2>&1
  fixture_rc=$?
}

restore_coverage
run_fixture 70
assert_rc 0 "$fixture_rc" "истечение само обновляет проверку и запускает узел"
assert_eq done "$(get 70 BUILD)" "результат агента записан после свежей проверки"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "после обновления ровно один запуск primary"
# Обычный dispatch проверяет primary при resolve и непосредственно перед invoke.
# Полный preflight добавляет ровно одну проверку каждого кандидата перед ними.
assert_eq $'alpha\nbeta\nalpha\nalpha' "$(cat "$TEST_ROOT/probes")" \
  "перед dispatch заново проверены metadata обоих исполнителей"
assert_eq 0 "$(get 70 STALLED_HUMAN)" "истечение не требует ручного продолжения"
assert_eq primary "$(get 70 RUNNER_REASON_BUILD)" "цепочка исполнителей не подменяется"
assert_contains "$(cat "$LOGDIR/t70.stages.log" 2>/dev/null)" 'истёк срок' \
  "причина перепроверки видна в журнале задачи"
assert_contains "$(cat "$LOGDIR/t70.stages.log" 2>/dev/null)" 'обновлена' \
  "успешное обновление видно в журнале задачи"
expires=$(coverage_artifact_get "$coverage/host.env" EXPIRES_AT)
[[ "$expires" -gt "$(date +%s)" ]]
assert_rc 0 "$?" "новый срок получен настоящим preflight"

# Свежий снимок не запускает полный preflight заново на каждом узле.
# Недоступный сейчас резерв обнаруживался бы только при такой лишней проверке.
: >"$TEST_ROOT/probes"
: >"$TEST_ROOT/invocations"
fresh_hash=$(sha256sum "$coverage/host.env")
export FAKE_BETA_PROBE=missing
run_fixture 71
assert_rc 0 "$fixture_rc" "свежий снимок продолжает обычный путь primary"
assert_eq $'alpha\nalpha' "$(cat "$TEST_ROOT/probes")" "свежий coverage не повторяет общий preflight"
assert_eq "$fresh_hash" "$(sha256sum "$coverage/host.env")" "срок свежего снимка не продлевается"

restore_coverage
run_fixture 72
assert_rc 0 "$fixture_rc" "следующее истечение тоже обновляется автоматически"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "повторное обновление не дублирует model call"

for provider in alpha beta; do
  restore_coverage
  if [[ "$provider" == alpha ]]; then
    export FAKE_ALPHA_PROBE=missing
  else
    export FAKE_BETA_PROBE=missing
  fi
  task=73
  [[ "$provider" == alpha ]] || task=74
  run_fixture "$task"
  assert_rc 0 "$fixture_rc" "недоступный $provider не блокирует готового кандидата цепочки"
  actual=alpha
  reason=primary
  if [[ "$provider" == alpha ]]; then
    actual=beta
    reason=unavailable_preflight
    assert_contains "$(cat "$LOGDIR/t${task}.stages.log")" 'alpha недоступен по снимку' \
      "переход к объявленному резерву объяснён в журнале этапа"
  fi
  assert_eq "$actual" "$(cat "$TEST_ROOT/invocations")" "запущен только готовый $actual"
  assert_eq "$provider" "$(coverage_artifact_get "$coverage/host.env" UNAVAILABLE_RUNNERS)" \
    "новый preflight называет реально недоступного $provider"
  assert_eq "$reason" "$(get "$task" RUNNER_REASON_BUILD)" \
    "причина выбора кандидата сохраняется в реестре"
done

restore_coverage
export FAKE_ALPHA_PROBE=missing FAKE_BETA_PROBE=missing
run_fixture 95
assert_rc 79 "$fixture_rc" "полностью недоступная цепочка сохраняет fail-closed"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "нет готовых кандидатов — нет model call"
assert_eq 1 "$(get 95 STALLED_HUMAN)" "полностью недоступная цепочка требует человека"
assert_eq coverage_unavailable "$(get 95 RUNNER_REASON_BUILD)" "причина остановки сохраняется"

restore_coverage
export FAKE_CATALOG_MISSING=1
run_fixture 75
assert_rc 0 "$fixture_rc" "снятая модель primary разрешает объявленный готовый резерв"
assert_eq beta "$(cat "$TEST_ROOT/invocations")" "структурный отказ ведёт только в объявленный резерв"

restore_coverage
export FACTORY_HOST_PREFLIGHT_TTL=invalid
run_fixture 76
assert_rc 79 "$fixture_rc" "ошибка нового preflight не разрешает запуск"
assert_eq 160 "$(coverage_artifact_get "$coverage/host.env" EXPIRES_AT)" \
  "срок не продлевается без полноценной перепроверки"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "ошибка перепроверки не начинает model call"

restore_coverage
export FAKE_CONFIG_CHANGE="$config"
run_fixture 77
assert_rc 79 "$fixture_rc" "конфигурация, изменённая во время пробы, не проходит старую revision"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "revision повторно сверяется после обновления"

restore_coverage
export FACTORY_HOST_PREFLIGHT_TTL=1 FAKE_PROBE_DELAY=2
run_fixture 78
assert_rc 79 "$fixture_rc" "истёкший во время пробы новый снимок не принимается"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "после перепроверки используется новое время"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/probes")" "нет бесконечного цикла перепроверок"

# Автоматическое обновление разрешено только для корректного истёкшего снимка.
# Отсутствие, несовместимость и зафиксированная недоступность сохраняют прежний отказ.
task=80
for defect in missing revision structural-hash structural-unavailable host-unavailable expires numeric \
  structural-status host-status provider-list; do
  restore_coverage
  case "$defect" in
    missing) rm "$coverage/host.env" ;;
    revision) sed -i 's/CATALOG_REVISION=.*/CATALOG_REVISION=foreign/' "$coverage/host.env" ;;
    structural-hash) sed -i 's/STRUCTURAL_HASH=.*/STRUCTURAL_HASH=foreign/' "$coverage/host.env" ;;
    structural-unavailable) sed -i 's/=native$/=unavailable/' \
      "$coverage/structural.env" ;;
    host-unavailable) sed -i 's/=ready$/=unavailable/' "$coverage/host.env" ;;
    expires) sed -i 's/EXPIRES_AT=.*/EXPIRES_AT=invalid/' "$coverage/host.env" ;;
    numeric) sed -i 's/EXPIRES_AT=.*/EXPIRES_AT=08/' "$coverage/host.env" ;;
    structural-status) sed -i '/^PROVIDER_alpha=/d' "$coverage/structural.env" ;;
    host-status) sed -i 's/PROVIDER_alpha=ready/PROVIDER_alpha=unknown/' "$coverage/host.env" ;;
    provider-list) sed -i 's/PROVIDERS=.*/PROVIDERS=alpha/' "$coverage/host.env" ;;
  esac
  run_fixture "$task"
  assert_rc 79 "$fixture_rc" "повреждение $defect сохраняет fail-closed"
  assert_eq '' "$(cat "$TEST_ROOT/probes")" "повреждение $defect не запускает обновление"
  assert_eq '' "$(cat "$TEST_ROOT/invocations")" "повреждение $defect не начинает model call"
  task=$((task + 1))
done

# Прежняя схема не даёт допуска даже при положительных агрегатных счётчиках.
# Чтение узла вызывает единственную полную запись v2 и заново проверяет свою цепочку.
restore_coverage
sed -i 's/SCHEMA=2/SCHEMA=1/' "$coverage/structural.env" "$coverage/host.env"
sed -i '/^PROVIDER/d' "$coverage/structural.env" "$coverage/host.env"
sed -i "s/EXPIRES_AT=.*/EXPIRES_AT=$(( $(date +%s) + 3600 ))/" "$coverage/host.env"
run_fixture 96
assert_rc 0 "$fixture_rc" "SCHEMA=1 заменяется полноценной проверкой перед узлом"
assert_eq 2 "$(coverage_artifact_get "$coverage/structural.env" SCHEMA)" "структурный снимок переписан"
assert_eq 2 "$(coverage_artifact_get "$coverage/host.env" SCHEMA)" "хостовый снимок переписан"
assert_eq $'alpha\nbeta\nalpha\nalpha' "$(cat "$TEST_ROOT/probes")" \
  "старая схема не читается как разрешение без проб"

restore_coverage
sed -i 's/SCHEMA=2/SCHEMA=1/' "$coverage/structural.env" "$coverage/host.env"
export FACTORY_HOST_PREFLIGHT_TTL=invalid
run_fixture 97
assert_rc 79 "$fixture_rc" "SCHEMA=1 без успешного переписывания остаётся fail-closed"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "старая схема не разрешает model call"

# Runtime-sensitive резерв, как встроенный DeepSeek, сверяет сборку перед каждым узлом
# даже в пределах TTL. Легитимная смена сборки резерва не должна останавливать узел
# основного исполнителя: снимок обновляется один раз, как истёкший.
cat >>"$FACTORY_RUNNERS_DIR/beta.sh" <<'RUNNER'

# Сборка читается из файла при каждой пробе; без файла резерв прежний, не runtime.
runner_beta_refresh_probe() {
  [[ -f "$TEST_ROOT/beta-build" ]]
}

# Проба печатает версию с префиксом CLI, как настоящие раннеры. FAKE_BETA_FLIP
# переключает сборку после каждой пробы: публикация не устоялась за обновление.
runner_beta_probe() {
  local build
  printf 'beta\n' >>"$TEST_ROOT/probes"
  if [[ "${FAKE_BETA_PROBE:-}" == incompatible ]]; then
    printf 'RUNNER_SUPPLY_INCOMPATIBLE=beta\n' >&2
    return 4
  fi
  [[ "${FAKE_BETA_PROBE:-ready}" == ready ]] || return 4
  if [[ ! -f "$TEST_ROOT/beta-build" ]]; then
    printf 'ready\n'
    return 0
  fi

  build=$(cat "$TEST_ROOT/beta-build")
  printf 'beta-cli %s\n' "$build"
  if [[ "${FAKE_BETA_FLIP:-0}" == 1 ]]; then
    if [[ "$build" == 1.1.0 ]]; then
      printf '1.2.0\n' >"$TEST_ROOT/beta-build"
    else
      printf '1.1.0\n' >"$TEST_ROOT/beta-build"
    fi
  fi
}
RUNNER

# Резерв назван дважды: сверка сборки обязана пробовать его один раз.
cat >"$config" <<'CONFIG'
RUNNERS_SCHEMA=1
CONFIG_REVISION=3
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=beta
STAGE_REVIEW_FAILOVER=beta
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
MODEL_DEFAULT_BETA_FAMILY=fixture
MODEL_DEFAULT_BETA_VERSION=latest
CONFIG
restore_coverage
printf '1.0.0\n' >"$TEST_ROOT/beta-build"
profile_runner_host_preflight fixture
assert_rc 0 "$?" "свежий preflight фиксирует сборку runtime-sensitive резерва"
assert_eq 1.0.0 "$(coverage_artifact_get "$coverage/host.env" RUNTIME_VERSION_beta)" \
  "снимок хранит версию сборки без префикса CLI"
cp "$coverage/host.env" "$TEST_ROOT/host-runtime.env"
cp "$coverage/structural.env" "$TEST_ROOT/structural-runtime.env"
cp "$config" "$TEST_ROOT/config-runtime.env"

# Каждый runtime-случай начинает со свежего снимка сборки 1.0.0.
# Срок не истёк, поэтому обновление может вызвать только сверка сборки.
restore_runtime_coverage() {
  cp "$TEST_ROOT/host-runtime.env" "$coverage/host.env"
  cp "$TEST_ROOT/structural-runtime.env" "$coverage/structural.env"
  cp "$TEST_ROOT/config-runtime.env" "$config"
  : >"$TEST_ROOT/invocations"
  : >"$TEST_ROOT/probes"
  unset FAKE_ALPHA_PROBE FAKE_BETA_PROBE FAKE_BETA_FLIP
  printf '%s\n' "$1" >"$TEST_ROOT/beta-build"
}

restore_runtime_coverage 1.0.0
run_fixture 90
assert_rc 0 "$fixture_rc" "неизменная сборка резерва не мешает узлу"
assert_eq $'beta\nalpha\nalpha' "$(cat "$TEST_ROOT/probes")" \
  "дважды названный резерв сверяется одной пробой без нового preflight"

restore_runtime_coverage 1.1.0
run_fixture 91
assert_rc 0 "$fixture_rc" "смена сборки резерва обновляет снимок и продолжает узел"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "основной исполнитель запущен ровно один раз"
assert_eq 0 "$(get 91 STALLED_HUMAN)" "смена сборки резерва не требует человека"
assert_eq primary "$(get 91 RUNNER_REASON_BUILD)" "цепочка исполнителей не подменяется"
assert_eq 1.1.0 "$(coverage_artifact_get "$coverage/host.env" RUNTIME_VERSION_beta)" \
  "обновлённый снимок хранит новую сборку"
assert_eq $'beta\nalpha\nbeta\nbeta\nalpha\nalpha' "$(cat "$TEST_ROOT/probes")" \
  "сверка, один полный preflight и повторная сверка перед dispatch"
assert_contains "$(cat "$LOGDIR/t91.stages.log" 2>/dev/null)" 'сменилась сборка' \
  "причина обновления видна в журнале задачи"
assert_contains "$(cat "$LOGDIR/t91.stages.log" 2>/dev/null)" 'обновлена' \
  "успешное обновление видно в журнале задачи"
[[ "$(cat "$TEST_ROOT/task-91.log")" != *FACTORY_ERROR* ]]
assert_rc 0 "$?" "успешное обновление не оставляет маршруту ложную ошибку runtime"

restore_runtime_coverage 1.1.0
export FAKE_BETA_FLIP=1
run_fixture 92
assert_rc 79 "$fixture_rc" "сборка, не совпавшая и после обновления, останавливает узел"
assert_eq '' "$(cat "$TEST_ROOT/invocations")" "нестабильная сборка не начинает model call"
assert_eq 1 "$(get 92 STALLED_HUMAN)" "остановка требует человека"
assert_eq coverage_unavailable "$(get 92 RUNNER_REASON_BUILD)" "причина остановки сохранена"
assert_eq $'beta\nalpha\nbeta\nbeta' "$(cat "$TEST_ROOT/probes")" \
  "после неудачной сверки второго обновления нет"
assert_contains "$(cat "$TEST_ROOT/task-92.log")" 'FACTORY_ERROR=runtime_changed RUNNERS=beta' \
  "маршрут получает понятную причину остановки"

restore_runtime_coverage 1.1.0
export FAKE_BETA_PROBE=missing
run_fixture 93
assert_rc 0 "$fixture_rc" "недоступный резерв после смены сборки не останавливает primary"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "доступный primary продолжает узел"
assert_eq primary "$(get 93 RUNNER_REASON_BUILD)" "выбор primary сохранён"

restore_runtime_coverage 1.1.0
export FAKE_BETA_PROBE=missing
profile_runner_host_preflight fixture
assert_rc 1 "$?" "полный preflight по-прежнему сообщает недоступность провайдера профиля"
: >"$TEST_ROOT/probes"
run_fixture 94 alpha
assert_rc 0 "$fixture_rc" "недоступный runtime-провайдер вне цепочки узла не блокирует запуск"
assert_eq $'alpha\nalpha' "$(cat "$TEST_ROOT/probes")" \
  "сборка провайдера вне цепочки не сверяется и общий preflight не повторяется"
rm -f -- "$TEST_ROOT/beta-build"

# Настоящий start/gate/resume использует опубликованный bundle и trusted cursor.
# После ворот BUILD уже недостижим: его beta не должен блокировать SHIP с task-stage override.
profile_dir="$FACTORY_PROFILES_DIR/demo-profile"
repo="$TEST_ROOT/resume-checkout"
routes="$TEST_ROOT/resume-routes"
mkdir -p "$profile_dir" "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.test
git -C "$repo" checkout -qb shared-main
printf 'исходное состояние\n' >"$repo/tracked.txt"
git -C "$repo" add tracked.txt
git -C "$repo" commit -qm 'исходное состояние'
cat >"$profile_dir/profile.sh" <<PROFILE
PROFILE_NAME=demo-profile
profile_workspace_mode() { printf 'shared\\n'; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' '$repo' '$repo'; }
profile_source_branch() { printf 'shared-main\\n'; }
profile_container() { printf 'fixture-stand\\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\\t8830\\n'; }
profile_exclusive_resources() { printf '%s\\n' 'stand:fixture-stand' 'workspace:$repo'; }
PROFILE
cat >"$profile_dir/runners.env" <<'CONFIG'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=
STAGE_BUILD_PRIMARY=beta
STAGE_SHIP_PRIMARY=beta
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
MODEL_DEFAULT_BETA_FAMILY=fixture
MODEL_DEFAULT_BETA_VERSION=latest
CONFIG
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"
"$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs" "$routes" null \
  >"$TEST_ROOT/resume-catalog.json"
assert_rc 0 "$?" "каталог опубликован для проверки охвата resume"
cat >"$TEST_ROOT/resume-ticket.json" <<'JSON'
{"schema":1,"taskId":"98","title":"проверка resume","description":"продолжить после ворот",
 "acceptanceCriteria":["исполнитель вне цепочки не блокирует"],"sourceUrl":"https://example.test/98"}
JSON

# Каждый запуск использует отдельные roots; реальный профиль и стоящие задачи недоступны.
# Живой запрет снимается только для локальных fake runners, без CLI модели и внешних служб.
resume_factory() {
  FACTORY_FORBID_LIVE=0 "$FACTORY_HOME/bin/factory" 98 "$@" \
    --profile demo-profile --routes-dir "$routes" \
    --state-dir "$TEST_ROOT/resume-state" --control-dir "$TEST_ROOT/resume-control"
}

unset FAKE_BETA_PROBE
: >"$TEST_ROOT/invocations"
resume_factory start --route trivial --ticket-json "$TEST_ROOT/resume-ticket.json" \
  --delivery-target app=main >"$TEST_ROOT/scoped-start.log" 2>&1
start_rc=$?
if (( start_rc != 0 )); then
  test_note "start: $(cat "$TEST_ROOT/scoped-start.log")"
fi
assert_rc 0 "$start_rc" "start проходит цепочки всех узлов и останавливается на воротах"
registry="$TEST_ROOT/resume-state/t98.pipeline"
attempt=$(awk -F= '$1=="ATTEMPT_ID"{print $2}' "$registry")
assert_eq waiting "$(awk -F= '$1=="GATE_ACCEPT"{print $2}' "$registry")" "ворота действительно достигнуты"
export FAKE_BETA_PROBE=missing
resume_factory gate --attempt "$attempt" --node gate_accept --decision approved --commit-only \
  >"$TEST_ROOT/scoped-gate.log" 2>&1
assert_rc 0 "$?" "решение ворот записывается без preflight снятого исполнителя"
before_resume=$(cat "$TEST_ROOT/invocations")
resume_factory resume --attempt "$attempt" >"$TEST_ROOT/scoped-blocked-resume.log" 2>&1
assert_rc 1 "$?" "resume требует недоступный primary реально достижимого SHIP"
assert_contains "$(cat "$TEST_ROOT/scoped-blocked-resume.log")" \
  'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=beta' "отказ называет только цепочку SHIP"
assert_eq "$before_resume" "$(cat "$TEST_ROOT/invocations")" "отказ resume не вызывает модель"

# Перепривязка разрешена только при покрытии всей блокирующей цепочки.
# Один посторонний отказ остаётся unavailable, даже если сосед сообщил о поставке.
export FAKE_BETA_PROBE=incompatible
resume_factory resume --attempt "$attempt" >"$TEST_ROOT/supply-resume.log" 2>&1
assert_rc 1 "$?" "несовместимая поставка оставляет rc=1 preflight"
assert_contains "$(cat "$TEST_ROOT/supply-resume.log")" \
  'FACTORY_ERROR=runner_preflight_incompatible RUNNERS=beta' "все недоступные покрыты маркером"

printf 'STAGE_SHIP_FAILOVER=alpha\n' >>"$profile_dir/runners.env"
export FAKE_ALPHA_PROBE=missing
resume_factory resume --attempt "$attempt" >"$TEST_ROOT/mixed-resume.log" 2>&1
assert_rc 1 "$?" "смесь причин оставляет rc=1 preflight"
assert_contains "$(cat "$TEST_ROOT/mixed-resume.log")" \
  'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=alpha,beta' "смесь причин не разрешает перепривязку"

export FAKE_ALPHA_PROBE=incompatible
resume_factory resume --attempt "$attempt" >"$TEST_ROOT/all-supply-resume.log" 2>&1
assert_rc 1 "$?" "несовместимость всей цепочки блокирует запуск"
assert_contains "$(cat "$TEST_ROOT/all-supply-resume.log")" \
  'FACTORY_ERROR=runner_preflight_incompatible RUNNERS=alpha,beta' "проверяется покрытие каждого кандидата"
assert_eq "$before_resume" "$(cat "$TEST_ROOT/invocations")" "все отказы поставки предшествуют model call"
assert_eq approved "$(awk -F= '$1=="GATE_ACCEPT"{print $2}' "$registry")" \
  "проверки поставки сохраняют решение ворот"
sed -i '/^STAGE_SHIP_FAILOVER=/d' "$profile_dir/runners.env"
unset FAKE_ALPHA_PROBE
export FAKE_BETA_PROBE=missing

# Реестровый primary расходится с pin: runtime восстановит пустое значение запуска.
# Preflight должен видеть ту же цепочку, сохраняя независимый task-stage override.
STATE_DIR="$TEST_ROOT/resume-state" pipeline_store_update 98 \
  RUNNER_OVERRIDE_PRIMARY beta RUNNER_OVERRIDE_STAGE_SHIP alpha
: >"$TEST_ROOT/invocations"
resume_factory resume --attempt "$attempt" >"$TEST_ROOT/scoped-resume.log" 2>&1
resume_rc=$?
if (( resume_rc != 0 )); then
  test_note "resume: $(cat "$TEST_ROOT/scoped-resume.log")"
  test_note "этапы: $(cat "$TEST_ROOT/resume-state/logs/t98.stages.log")"
fi
assert_rc 0 "$resume_rc" "resume после ворот с override SHIP не требует снятого исполнителя"
assert_eq $'alpha\nalpha' "$(cat "$TEST_ROOT/invocations")" "только оставшиеся SHIP и RETRO вызвали primary"
assert_eq alpha "$(awk -F= '$1=="RUNNER_ACTUAL_SHIP"{print $2}' "$registry")" \
  "SHIP использовал task-stage override"
assert_eq '' "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$registry")" \
  "preflight учёл восстановленный runtime primary из trusted launch identity"
assert_eq completed "$(awk -F= '$1=="RESULT"{print $2}' "$registry")" "попытка завершена после ворот"
assert_eq unavailable \
  "$(coverage_artifact_get "$TEST_ROOT/resume-state/coverage/demo-profile/host.env" PROVIDER_beta)" \
  "снимок честно сохраняет недоступность beta вне оставшихся цепочек"

finish_tests
