#!/usr/bin/env bash
set -uo pipefail

source "$FACTORY_TESTS_HOME/lib/testlib.sh"

PROJECT_ROOT="$(cd "$FACTORY_HOME/.." && pwd)"
host_root="${PROJECT_ROOT%%/Workspace/*}"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(find "$host_root/.nvm/versions/node" /usr/local /opt \
    -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1)
fi
repeat="${TEST_REPEAT:-5}"

for iteration in $(seq 1 "$repeat"); do
  pids=()
  run_id="rr-fencing-$iteration"
  race_dir="$TEST_ROOT/race-$iteration"
  mkdir -p "$race_dir"
  PROJECT_ROOT="$PROJECT_ROOT" RUN_ID="$run_id" \
    "$NODE_BIN" --input-type=module <<'NODE'
const { ReviewStateStore, createReviewRunState } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/review-state-machine.js`
);
const store = new ReviewStateStore({ stateDir: process.env.STATE_DIR });
await store.create(createReviewRunState({
  reviewRunId: process.env.RUN_ID,
  projectId: 'demo',
  repositoryId: 'repo',
  prNumber: 1,
  snapshot: { digest: 'snap', version: 'v1', headSha: 'a'.repeat(40) },
  binding: {
    repoPath: '/tmp/repo',
    headRepoUrl: '/tmp/fork.git',
    headRef: 'refs/heads/feature',
    headSha: 'a'.repeat(40),
  },
}));
NODE

  for worker in a b; do
    PROJECT_ROOT="$PROJECT_ROOT" RUN_ID="$run_id" WORKER="$worker" RACE_DIR="$race_dir" \
      "$NODE_BIN" --input-type=module >"$race_dir/$worker.log" 2>&1 <<'NODE' &
import { writeFile } from 'node:fs/promises';
const { ReviewStateStore } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/review-state-machine.js`
);
await writeFile(`${process.env.RACE_DIR}/ready-${process.env.WORKER}`, '');
while (true) {
  try {
    await import('node:fs/promises').then((fs) => fs.access(`${process.env.RACE_DIR}/go`));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const store = new ReviewStateStore({ stateDir: process.env.STATE_DIR });
try {
  const state = await store.acquireLease(process.env.RUN_ID, {
    owner: process.env.WORKER,
    now: 1_000,
    ttlMs: 100,
  });
  await writeFile(
    `${process.env.RACE_DIR}/result-${process.env.WORKER}`,
    `win ${state.lease.fencingToken}\n`,
  );
} catch (error) {
  await writeFile(
    `${process.env.RACE_DIR}/result-${process.env.WORKER}`,
    `${error.code}\n`,
  );
}
NODE
    pids+=("$!")
  done

  while [[ ! -f "$race_dir/ready-a" || ! -f "$race_dir/ready-b" ]]; do sleep 0.002; done
  : >"$race_dir/go"
  wait "${pids[-2]}" "${pids[-1]}"
  first=$(<"$race_dir/result-a")
  second=$(<"$race_dir/result-b")
  combined="$first|$second"
  if [[ ( "$first" == win\ * && "$second" == "LEASE_BUSY" ) \
     || ( "$second" == win\ * && "$first" == "LEASE_BUSY" ) ]]; then
    test_ok "WATCH-RACE-01 RUN-08 [$iteration]: lease получил ровно один процесс"
  else
    test_fail "WATCH-RACE-01 RUN-08 [$iteration]: lease получил ровно один процесс" "$combined"
  fi

  if [[ "$first" == win\ * ]]; then
    old_owner=a
    old_token=${first#win }
  else
    old_owner=b
    old_token=${second#win }
  fi
  PROJECT_ROOT="$PROJECT_ROOT" RUN_ID="$run_id" OLD_OWNER="$old_owner" OLD_TOKEN="$old_token" \
    "$NODE_BIN" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { ReviewStateStore } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/review-state-machine.js`
);
const store = new ReviewStateStore({ stateDir: process.env.STATE_DIR });
const next = await store.acquireLease(process.env.RUN_ID, {
  owner: 'replacement',
  now: 1_101,
  ttlMs: 100,
});
assert.ok(next.lease.fencingToken > Number(process.env.OLD_TOKEN));
await assert.rejects(
  store.update(process.env.RUN_ID, (state) => ({ ...state, status: 'failed' }), {
    owner: process.env.OLD_OWNER,
    fencingToken: Number(process.env.OLD_TOKEN),
  }),
  (error) => error.code === 'FENCING_TOKEN_STALE',
);
NODE
  rc=$?
  assert_rc 0 "$rc" "WATCH-RACE-02 RUN-03 [$iteration]: поздняя запись отсечена fencing token"

  create_pids=()
  for worker in a b; do
    PROJECT_ROOT="$PROJECT_ROOT" WORKER="$worker" ITERATION="$iteration" RACE_DIR="$race_dir" \
      "$NODE_BIN" --input-type=module >"$race_dir/create-$worker.log" 2>&1 <<'NODE' &
import { writeFile } from 'node:fs/promises';
const { ReviewStateStore, createReviewRunState } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/review-state-machine.js`
);
const store = new ReviewStateStore({ stateDir: process.env.STATE_DIR });
const id = `rr-create-${process.env.ITERATION}-${process.env.WORKER}`;
try {
  await store.createExclusive(createReviewRunState({
    reviewRunId: id,
    projectId: 'create-race',
    repositoryId: 'repo',
    prNumber: 100 + Number(process.env.ITERATION),
    snapshot: { digest: 'snap', version: 'v1', headSha: 'a'.repeat(40) },
    binding: {
      repoPath: '/tmp/repo',
      headRepoUrl: '/tmp/fork.git',
      headRef: 'refs/heads/feature',
      headSha: 'a'.repeat(40),
    },
  }));
  await writeFile(`${process.env.RACE_DIR}/create-result-${process.env.WORKER}`, 'win\n');
} catch (error) {
  await writeFile(
    `${process.env.RACE_DIR}/create-result-${process.env.WORKER}`,
    `${error.code}\n`,
  );
}
NODE
    create_pids+=("$!")
  done
  wait "${create_pids[@]}"
  create_first=$(<"$race_dir/create-result-a")
  create_second=$(<"$race_dir/create-result-b")
  if [[ ( "$create_first" == "win" && "$create_second" == "ACTIVE_RUN_EXISTS" ) \
     || ( "$create_second" == "win" && "$create_first" == "ACTIVE_RUN_EXISTS" ) ]]; then
    test_ok "RUN-04 [$iteration]: root CAS создаёт один active run на PR"
  else
    test_fail "RUN-04 [$iteration]: root CAS создаёт один active run на PR" \
      "$create_first|$create_second"
  fi

  control_file="$race_dir/control.json"
  PROJECT_ROOT="$PROJECT_ROOT" CONTROL_FILE="$control_file" \
    "$NODE_BIN" --input-type=module <<'NODE'
const { ReviewControlStore } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/control-store.js`
);
const store = new ReviewControlStore({
  filePath: process.env.CONTROL_FILE,
  now: () => 1_000,
});
await store.init();
await store.mutate((state) => {
  state.runLinks['rr-control-race'] = {
    runId: 'rr-control-race',
    pullId: 'pull-control-race',
  };
  state.queue.push('rr-control-race');
});
NODE

  control_pids=()
  for worker in a b; do
    PROJECT_ROOT="$PROJECT_ROOT" CONTROL_FILE="$control_file" WORKER="$worker" RACE_DIR="$race_dir" \
      "$NODE_BIN" --input-type=module >"$race_dir/control-$worker.log" 2>&1 <<'NODE' &
import { writeFile } from 'node:fs/promises';
const { ReviewControlStore } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/control-store.js`
);
await writeFile(`${process.env.RACE_DIR}/control-ready-${process.env.WORKER}`, '');
while (true) {
  try {
    await import('node:fs/promises').then(
      (fs) => fs.access(`${process.env.RACE_DIR}/control-go`),
    );
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const store = new ReviewControlStore({
  filePath: process.env.CONTROL_FILE,
  now: () => 1_000,
});
const claim = await store.claimNextRun({
  workerId: process.env.WORKER,
  leaseMs: 100,
});
await writeFile(
  `${process.env.RACE_DIR}/control-result-${process.env.WORKER}`,
  claim ? `win ${claim.fencingToken}\n` : 'busy\n',
);
NODE
    control_pids+=("$!")
  done

  while [[ ! -f "$race_dir/control-ready-a" || ! -f "$race_dir/control-ready-b" ]]; do
    sleep 0.002
  done
  : >"$race_dir/control-go"
  wait "${control_pids[@]}"
  control_first=$(<"$race_dir/control-result-a")
  control_second=$(<"$race_dir/control-result-b")
  if [[ ( "$control_first" == win\ * && "$control_second" == "busy" ) \
     || ( "$control_second" == win\ * && "$control_first" == "busy" ) ]]; then
    test_ok "QUEUE-01 [$iteration]: queued run получает ровно один процесс"
  else
    test_fail "QUEUE-01 [$iteration]: queued run получает ровно один процесс" \
      "$control_first|$control_second"
  fi

  if [[ "$control_first" == win\ * ]]; then
    control_old_owner=a
    control_old_token=${control_first#win }
  else
    control_old_owner=b
    control_old_token=${control_second#win }
  fi
  PROJECT_ROOT="$PROJECT_ROOT" CONTROL_FILE="$control_file" \
    OLD_OWNER="$control_old_owner" OLD_TOKEN="$control_old_token" \
    "$NODE_BIN" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { ReviewControlStore } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/control-store.js`
);
const store = new ReviewControlStore({
  filePath: process.env.CONTROL_FILE,
  now: () => 2_001,
});
const recovered = await store.claimNextRun({
  workerId: 'replacement',
  leaseMs: 100,
});
assert.equal(recovered.runId, 'rr-control-race');
assert.ok(recovered.fencingToken > Number(process.env.OLD_TOKEN));
await assert.rejects(
  store.releaseRunClaim({
    runId: recovered.runId,
    workerId: process.env.OLD_OWNER,
    fencingToken: Number(process.env.OLD_TOKEN),
  }),
  (error) => error.code === 'STALE_FENCE',
);
NODE
  rc=$?
  assert_rc 0 "$rc" \
    "RECOVER-RACE-01 [$iteration]: истёкший scheduler отсечён fencing token"
done

finish_tests
