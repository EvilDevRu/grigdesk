#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/executor.sh"

# Положительные проверки запускают fixture CLI; offline-сторож проверяется отдельно ниже.
FACTORY_FORBID_LIVE=0

# Fixture доказывает wiring раннера, а не работу официального CLI: descriptor
# подменяет поиск по PATH, а helper — только точку входа.
user_bin="$TEST_ROOT/user/bin"
mkdir -p "$user_bin"
capture="$TEST_ROOT/claude-run.txt"
helper="$TEST_ROOT/lease-helper.sh"
descriptor="$TEST_ROOT/external-cli-factory.json"
identity=$(printf '%064d' 1)
resource=$(printf '%064d' 2)

cat >"$helper" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  [ "$1" = "--" ] && { shift; break; }
  shift
done
exec "$@"
EOF
chmod 755 "$helper"

cat >"$user_bin/claude" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '2.9.999 fixture\\n'
  exit 0
fi
printf '%s\\n' "\$PWD|\$PATH|\${FIXTURE_MARK:-}|\$*" >"$capture"
EOF
chmod 755 "$user_bin/claude"

python3 - "$descriptor" "$user_bin" "$helper" "$identity" "$resource" <<'PYTHON'
import json
import sys

descriptor, user_bin, helper, identity, resource = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "providers": {
        "claude": {
            "bin": f"{user_bin}/claude",
            "identity": identity,
            "providerId": "claude",
            "resourceKey": resource,
            "leaseDirectory": f"{user_bin}/leases",
            "leaseCommand": [helper],
            "env": {
                "PATH": f"{user_bin}:/usr/bin:/bin",
                "FIXTURE_MARK": "user-environment",
            },
        },
    },
    "unavailable": {},
}
with open(descriptor, "w", encoding="utf-8") as target:
    json.dump(document, target)
PYTHON

export FACTORY_EXTERNAL_CLI_DESCRIPTOR="$descriptor"

bin=$(factory_external_bin claude claude)
assert_eq "$user_bin/claude" "$bin" "descriptor выбирает абсолютную копию вместо имени из PATH"

rm -f "$capture"
factory_external_exec claude claude --run fixture-argument
assert_rc 0 "$?" "probe через helper завершается успешно"
assert_file_exists "$capture" "CLI действительно запущен через helper"
capture_line=$(cat "$capture")
assert_contains "$capture_line" "user-environment" "descriptor передаёт пользовательскую переменную"
assert_contains "$capture_line" "$user_bin:/usr/bin:/bin" "CLI получает PATH пользовательского терминала"
assert_contains "$capture_line" "--run fixture-argument" "аргументы стадии доходят до CLI"
assert_contains "$capture_line" "fixture-argument" "аргументы стадии не подменяются"

factory_external_launch claude claude --launch-check
assert_rc 0 "$?" "launch собирает команду"
assert_contains "${FACTORY_EXTERNAL_LAUNCH[*]}" "$helper" "launch ставит helper перед CLI"
assert_contains "${FACTORY_EXTERNAL_LAUNCH[*]}" "$user_bin/claude" "launch сохраняет абсолютный бинарь"
launched=$("${FACTORY_EXTERNAL_LAUNCH[@]}" 2>&1)
assert_rc 0 "$?" "собранная команда исполняется"
capture_line=$(cat "$capture")
assert_contains "$capture_line" "--launch-check" "launch передаёт аргументы CLI"

unset FACTORY_EXTERNAL_CLI_DESCRIPTOR
fallback=$(factory_external_bin claude claude)
assert_eq "claude" "$fallback" "без descriptor-а остаётся прежний поиск по имени"

FACTORY_EXTERNAL_CLI_DESCRIPTOR="$descriptor"
FACTORY_FORBID_LIVE=1
rm -f "$capture"
factory_external_exec claude claude --version >/dev/null 2>&1
assert_rc 126 "$?" "offline-сторож блокирует внешний бинарь и через descriptor"
assert_file_missing "$capture" "заблокированный CLI не запускается"

cat >"$descriptor" <<'EOF'
{"schemaVersion":1,"providers":{"claude":{"bin":"claude","identity":"x","providerId":"claude","resourceKey":"y","leaseDirectory":"/tmp","leaseCommand":["/bin/true"],"env":{}}},"unavailable":{}}
EOF
FACTORY_FORBID_LIVE=0
fallback=$(factory_external_bin claude claude)
assert_eq "claude" "$fallback" "невалидный descriptor отвергается до запуска"

finish_tests
