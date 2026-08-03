#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source "$FACTORY_PROFILES_DIR/arsenkin/lib.sh"

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$name"
  else
    fail=$((fail + 1)); printf 'not ok %d - %s (got %q)\n' "$((pass + fail))" "$name" "$actual"
  fi
}

check 'isolated route resolves its only worktree topology' \
  $'/home/evildev/Workspace/arsenkin/be/route-worktree-t8162\t/home/evildev/Workspace/arsenkin/fe/route-worktree-t8162' \
  "$(sandbox_worktree_paths 8162)"

reservation="$TEST_ROOT/slot.json"
printf '{"task":"8162","k":3,"at":1}\n' >"$reservation"
check 'partial cleanup recovers the exact reserved slot' '3' \
  "$(sandbox_reservation_slot "$reservation" 8162)"
if sandbox_reservation_slot "$reservation" 8165 >/dev/null 2>&1; then
  wrong_task=accepted
else
  wrong_task=rejected
fi
check 'reservation for another task is rejected' 'rejected' "$wrong_task"

printf '1..%d\n' "$((pass + fail))"
(( fail == 0 ))
