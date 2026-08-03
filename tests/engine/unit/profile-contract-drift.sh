#!/usr/bin/env bash
# Расхождение закреплённого контракта попытки с текущим профилем обязано называть поле:
# resume отказывает кодом 75, и без адреса человек четыре раза жмёт «продолжить»
# вслепую (так было на t7802 — уехали guardrails профиля).
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-state.sh"

work="$TEST_ROOT/work/contract"
mkdir -p "$work"

pinned_tsv="$work/pinned.tsv"
actual_tsv="$work/actual.tsv"
pinned_json="$work/pinned.json"
actual_json="$work/actual.json"

manifest() {
  local file=$1 container=$2 worktree=$3
  {
    printf 'schema\t1\n'
    printf 'repos-mode\tgeneric\n'
    printf 'workspace-mode\tisolated\n'
    printf 'container\t%s\n' "$container"
    printf 'repo\tbackend\t/src/be\t%s\n' "$worktree"
  } >"$file"
}

context() {
  local file=$1 guardrail=$2
  printf '{"guardrails":["%s"],"stack":["Laravel 12"]}\n' "$guardrail" >"$file"
}

manifest "$pinned_tsv" ars-sb-t1-application-1 /src/be/worktree-t1
manifest "$actual_tsv" ars-sb-t1-application-1 /src/be/worktree-t1
context "$pinned_json" 'не трогать чужой долг'
context "$actual_json" 'не трогать чужой долг'

drift=$(attempt_state_contract_drift_v2 "$pinned_tsv" "$actual_tsv" "$pinned_json" "$actual_json")
assert_eq "расхождение не локализовано" "$drift" "identical contract has no named field"

# Изменился только текст guardrails — ровно случай t7802.
context "$actual_json" 'форматировать pint можно только свои файлы'
drift=$(attempt_state_contract_drift_v2 "$pinned_tsv" "$actual_tsv" "$pinned_json" "$actual_json")
assert_eq "project-context: guardrails" "$drift" "changed guardrails are named by key"

# Уехавший worktree — та же строка repo, но другое значение.
manifest "$actual_tsv" ars-sb-t1-application-1 /src/be/worktree-t2
drift=$(attempt_state_contract_drift_v2 "$pinned_tsv" "$actual_tsv" "$pinned_json" "$actual_json")
assert_eq "profile-contract: repo; project-context: guardrails" "$drift" \
  "both halves of the contract are reported together"

# Поле пропало целиком: в текущем профиле его нет, в закреплённом было.
context "$actual_json" 'не трогать чужой долг'
grep -v '^container' "$pinned_tsv" >"$actual_tsv"
drift=$(attempt_state_contract_drift_v2 "$pinned_tsv" "$actual_tsv" "$pinned_json" "$actual_json")
assert_eq "profile-contract: container" "$drift" "a field lost by the profile is named too"

# Нечитаемый закреплённый контекст — не повод молчать: расхождение остаётся расхождением.
printf 'не json\n' >"$actual_json"
manifest "$actual_tsv" ars-sb-t1-application-1 /src/be/worktree-t1
drift=$(attempt_state_contract_drift_v2 "$pinned_tsv" "$actual_tsv" "$pinned_json" "$actual_json")
assert_eq "project-context: нечитаем" "$drift" "unreadable context is reported, not swallowed"
