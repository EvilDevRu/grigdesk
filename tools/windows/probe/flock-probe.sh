#!/usr/bin/env bash
set -eu

lock=$1
out=$(mktemp)
holder=
trap 'if [[ -n $holder ]]; then kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true; fi; rm -f "$out"' EXIT

(
  exec 9>"$lock"
  flock -n 9
  echo READY
  exec sleep 30
) >"$out" &
holder=$!

ready=false
contender=-1
reacquired=-1

for ((attempt=0; attempt<100; attempt++)); do
  if grep -qx READY "$out"; then
    ready=true
    break
  fi
  kill -0 "$holder" 2>/dev/null || break
  sleep .05
done

if [[ $ready == true ]]; then
  contender=0
  flock -E 73 -n "$lock" true || contender=$?
  kill "$holder"
  wait "$holder" 2>/dev/null || true
  holder=
  reacquired=0
  flock -E 73 -n "$lock" true || reacquired=$?
fi

printf '{"holderReady":%s,"contenderExit":%s,"reacquiredExit":%s}\n' \
  "$ready" "$contender" "$reacquired"
