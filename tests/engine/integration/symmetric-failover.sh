#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/breaker.sh lib/dispatcher.sh lib/runners/policy.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/breaker.sh"
source "$FACTORY_HOME/lib/dispatcher.sh"

declare -A FIXTURE_RESULT=()
declare -A FIXTURE_STARTED=()
declare -A FIXTURE_SCOPE=()
declare -A FIXTURE_RESOLVE_ERROR=()

fixture_resolve() {
  local provider=$1 requested_family=${2:-}
  if [[ "${FIXTURE_RESOLVE_ERROR[$provider]:-}" == invalid_config ]]; then
    DISPATCH_RESOLVE_RESULT=invalid_config
    return 4
  fi
  case "$provider" in
    claude)
      DISPATCH_RESOLVED_FAMILY=${requested_family:-opus}
      DISPATCH_RESOLVED_MODEL="claude-${DISPATCH_RESOLVED_FAMILY}-actual"
      DISPATCH_FAMILY_FAILOVER=fable
      DISPATCH_CREDENTIAL_FINGERPRINT=acct-claude ;;
    codex)
      DISPATCH_RESOLVED_FAMILY=${requested_family:-sol}
      DISPATCH_RESOLVED_MODEL="codex-${DISPATCH_RESOLVED_FAMILY}-actual"
      DISPATCH_FAMILY_FAILOVER=""
      DISPATCH_CREDENTIAL_FINGERPRINT=acct-codex ;;
    kimi)
      DISPATCH_RESOLVED_FAMILY=${requested_family:-k3}
      DISPATCH_RESOLVED_MODEL="kimi-${DISPATCH_RESOLVED_FAMILY}-actual"
      DISPATCH_FAMILY_FAILOVER=""
      DISPATCH_CREDENTIAL_FINGERPRINT=acct-kimi ;;
    *)
      return 4 ;;
  esac
}

fixture_invoke() {
  local provider=$1 family=$2 model=$3
  local key="$provider:$family"
  DISPATCH_INVOKE_RESULT=${FIXTURE_RESULT[$key]:-${FIXTURE_RESULT[$provider]:-ok}}
  DISPATCH_INVOKE_STARTED=${FIXTURE_STARTED[$key]:-${FIXTURE_STARTED[$provider]:-1}}
  DISPATCH_LIMIT_SCOPE=${FIXTURE_SCOPE[$key]:-${FIXTURE_SCOPE[$provider]:-provider}}
  DISPATCH_LIMIT_UNTIL=500
}

reset_fixture() {
  FIXTURE_RESULT=()
  FIXTURE_STARTED=()
  FIXTURE_SCOPE=()
  FIXTURE_RESOLVE_ERROR=()
  breaker_clear claude acct-claude provider "" "" 2>/dev/null || true
  breaker_clear claude acct-claude family opus "" 2>/dev/null || true
  breaker_clear codex acct-codex provider "" "" 2>/dev/null || true
  breaker_clear kimi acct-kimi provider "" "" 2>/dev/null || true
}

reset_fixture
FIXTURE_RESULT[claude]=limited
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 1 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "Claude-first chain survives Claude limit"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "Claude-first chain falls back to Codex"
assert_eq fallback_limit "$DISPATCH_REASON" "limit reason is visible"
assert_eq 0 "$DISPATCH_TRIES_DELTA" "provider failover spends no stage try"

reset_fixture
FIXTURE_RESULT[codex]=limited
FIXTURE_RESULT[claude]=ok
dispatcher_run_chain 2 PLAN codex claude 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "Codex-first chain survives Codex limit"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "Codex-first chain falls back to Claude"

reset_fixture
FIXTURE_RESULT[claude]=provider_unavailable
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 21 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "Claude-first chain survives a proven Claude account refusal"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "proven Claude refusal selects Codex"
assert_eq fallback_provider_unavailable "$DISPATCH_REASON" \
  "provider refusal is visible as the failover reason"

reset_fixture
FIXTURE_RESULT[codex]=provider_unavailable
FIXTURE_RESULT[claude]=ok
dispatcher_run_chain 22 PLAN codex claude 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "Codex-first chain survives a proven Codex account refusal"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "proven Codex refusal selects Claude"

reset_fixture
FIXTURE_RESULT[claude]=unknown
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 3 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 1 "$?" "unknown error stops automatic chain"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "unknown stays with failing provider"
assert_eq unknown "$DISPATCH_REASON" "non-switching error reason remains visible"

reset_fixture
FIXTURE_RESOLVE_ERROR[claude]=invalid_config
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 31 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 1 "$?" "invalid model config stops before fallback"
assert_eq "" "$DISPATCH_RESULT_RUNNER" "invalid config never invokes another provider"

reset_fixture
FIXTURE_RESULT[claude]=unavailable_preflight
FIXTURE_STARTED[claude]=0
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 4 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "preflight unavailability can skip provider"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "preflight selects project fallback"

reset_fixture
FIXTURE_RESULT[claude]=unavailable_preflight
FIXTURE_STARTED[claude]=1
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 5 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 1 "$?" "late auth error cannot pretend to be preflight"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "late error does not switch provider"

reset_fixture
FIXTURE_RESULT[claude]=limited
dispatcher_run_chain 6 PLAN claude "" 200 fixture_resolve fixture_invoke
assert_rc 2 "$?" "strict project stalls after its only provider limit"
assert_eq 1 "$DISPATCH_STALLED_HUMAN" "exhausted chain requests human"

reset_fixture
breaker_record claude acct-claude family opus "" 150 400 fixture-family
FIXTURE_RESULT[claude:fable]=ok
dispatcher_run_chain 7 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "family-specific limit can use explicit family fallback"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "family fallback stays on same provider"
assert_eq fable "$DISPATCH_RESULT_FAMILY" "configured family fallback is selected"

reset_fixture
FIXTURE_RESULT[claude:opus]=limited
FIXTURE_SCOPE[claude:opus]=family
FIXTURE_RESULT[claude:fable]=ok
dispatcher_run_chain 8 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "fresh family limit retries explicit family fallback immediately"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "fresh family limit stays on Claude"
assert_eq fable "$DISPATCH_RESULT_FAMILY" "fresh family fallback resolves Fable"
assert_eq fallback_limit "$DISPATCH_REASON" "family fallback reason is visible"

# Явный выбор человека сильнее предохранителя. Тот ставится по ПРОШЛОМУ отказу и
# всего лишь предполагает, что провайдер всё ещё в лимите; нажатая человеком кнопка
# «переключить на этого исполнителя» — факт. Молчаливая подмена выглядела как
# сломанная кнопка: человек переключал на claude, а этап уезжал в резерв.
reset_fixture
breaker_record claude acct-claude provider "" "" 150 400 fixture-provider
FIXTURE_RESULT[claude]=ok
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 9 PLAN claude codex 200 fixture_resolve fixture_invoke claude
assert_rc 0 "$?" "human choice enters a provider under the breaker"
assert_eq claude "$DISPATCH_RESULT_RUNNER" "human choice is not silently replaced"
assert_eq primary "$DISPATCH_REASON" "bypassed breaker is not reported as a failover"

# Предохранитель по семейству — такая же догадка: назначенный человеком провайдер
# перепроверяет её сам, вместо того чтобы сразу уехать на запасное семейство.
reset_fixture
breaker_record claude acct-claude family opus "" 150 400 fixture-family
FIXTURE_RESULT[claude:opus]=ok
dispatcher_run_chain 10 PLAN claude codex 200 fixture_resolve fixture_invoke claude
assert_rc 0 "$?" "human choice rechecks a family breaker instead of trusting it"
assert_eq opus "$DISPATCH_RESULT_FAMILY" "requested family is not swapped behind the human"

# Обход ИМЕННОЙ: он покрывает ровно того исполнителя, которого назвал человек.
# Резерв остаётся под предохранителем — иначе холостой заход делала бы вся цепочка.
reset_fixture
breaker_record claude acct-claude provider "" "" 150 400 fixture-provider
breaker_record codex acct-codex provider "" "" 150 400 fixture-provider
FIXTURE_RESULT[claude]=limited
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 11 PLAN claude codex 200 fixture_resolve fixture_invoke claude
assert_rc 2 "$?" "the bypass covers only the named provider"
assert_eq 1 "$DISPATCH_STALLED_HUMAN" "still-limited chain requests human"

# Без явного выбора всё остаётся как было: предохранитель экономит холостой заход.
reset_fixture
breaker_record claude acct-claude provider "" "" 150 400 fixture-provider
FIXTURE_RESULT[claude]=ok
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 12 PLAN claude codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "automatic routing still honours the breaker"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "automatic routing skips the limited provider"

reset_fixture
FIXTURE_RESULT[claude]=limited
FIXTURE_RESULT[kimi]=ok
dispatcher_run_chain 41 PLAN claude kimi 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "chain survives Claude limit with Kimi failover"
assert_eq kimi "$DISPATCH_RESULT_RUNNER" "Claude limit falls back to Kimi"
assert_eq fallback_limit "$DISPATCH_REASON" "limit reason is visible on failover to Kimi"
assert_eq 0 "$DISPATCH_TRIES_DELTA" "failover to Kimi spends no stage try"

# Кейсы 42-43 — generic-покрытие dispatcher'а, а не kimi-специфика: classify v1
# для kimi не эмитит limited/transient (сигнатуры не доказаны, см.
# docs/engine/KIMI.md); здесь зафиксирована только симметрия политики.
reset_fixture
FIXTURE_RESULT[kimi]=limited
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 42 PLAN kimi codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "chain survives Kimi limit with Codex failover"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "Kimi limit fails over to Codex"
assert_eq fallback_limit "$DISPATCH_REASON" "limit reason is visible on failover from Kimi"

reset_fixture
FIXTURE_RESULT[kimi]=transient
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 43 PLAN kimi codex 200 fixture_resolve fixture_invoke
assert_rc 1 "$?" "transient Kimi error stops automatic chain"
assert_eq kimi "$DISPATCH_RESULT_RUNNER" "transient stays with failing Kimi"
assert_eq transient "$DISPATCH_REASON" "transient reason remains visible"

reset_fixture
FIXTURE_RESULT[kimi]=unknown
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 44 PLAN kimi codex 200 fixture_resolve fixture_invoke
assert_rc 1 "$?" "unknown Kimi error stops automatic chain"
assert_eq kimi "$DISPATCH_RESULT_RUNNER" "unknown stays with failing Kimi"
assert_eq unknown "$DISPATCH_REASON" "non-switching Kimi error reason remains visible"

# provider_unavailable — единственный переключающий класс, который classify v1
# реально эмитит для kimi (доказанный отказ аккаунта, см. docs/engine/KIMI.md).
reset_fixture
FIXTURE_RESULT[kimi]=provider_unavailable
FIXTURE_RESULT[codex]=ok
dispatcher_run_chain 45 PLAN kimi codex 200 fixture_resolve fixture_invoke
assert_rc 0 "$?" "chain survives a proven Kimi account refusal"
assert_eq codex "$DISPATCH_RESULT_RUNNER" "proven Kimi refusal selects Codex"
assert_eq fallback_provider_unavailable "$DISPATCH_REASON" \
  "provider refusal is visible as the failover reason from Kimi"

finish_tests
