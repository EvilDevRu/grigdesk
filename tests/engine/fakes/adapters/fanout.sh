#!/usr/bin/env bash

adapter_fanout_version() {
  printf '1\n'
}

adapter_fanout_provides() {
  printf 'fanout\n'
}

adapter_fanout_preflight() {
  [[ "${FAKE_FANOUT_AVAILABLE:-1}" == 1 ]]
}

adapter_fanout_run() {
  printf 'fanout adapted\n'
}
