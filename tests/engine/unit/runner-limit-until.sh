#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# `limit_until` — ОПЦИОНАЛЬНЫЙ метод раннера: он отвечает на вопрос «до какого
# времени провайдер отказывает», когда сам CLI это время назвал. Без него
# предохранитель живёт по общему cooldown-у, то есть держит живой провайдер
# выключенным дольше, чем длится лимит.

for module in claude codex kimi; do
  if [[ ! -f "$FACTORY_HOME/lib/runners/$module.sh" ]]; then
    test_fail "runner $module exists" "missing lib/runners/$module.sh"
    finish_tests
    exit $?
  fi
done

source "$FACTORY_HOME/lib/runners/claude.sh"
source "$FACTORY_HOME/lib/runners/codex.sh"
source "$FACTORY_HOME/lib/runners/kimi.sh"

fixture() { printf '%s\n' "$FACTORY_TESTS_HOME/fixtures/classifiers/$1"; }

# Claude называет срок машинным полем: последний `rate_limit_event` со
# `status: rejected` несёт `resetsAt` (unix). Ранние `allowed_warning` того же
# окна брать нельзя — отказ фиксирует именно rejected.
actual=$(runner_claude_limit_until "$(fixture claude-runtime-session-limit)")
assert_rc 0 "$?" "claude reports a reset time when the CLI knows it"
assert_eq 1893456000 "$actual" "claude reads resetsAt of the rejected event"

# Тот же провайдер, но телеметрия без `resetsAt`: срока нет, и выдумывать его
# нельзя — предохранитель обязан упасть обратно на cooldown.
actual=$(runner_claude_limit_until "$(fixture claude-runtime-weekly-limit)")
assert_rc 1 "$?" "claude stays silent when the stream carries no reset time"
assert_eq "" "$actual" "no reset time means empty output"

# Codex срок печатает фразой: «try again at Jan 1st, 2030 12:00 AM». Порядковый
# суффикс и запятая ломают `date -d`, поэтому строка нормализуется до разбора.
expected=$(date -d "2030-01-01 00:00" +%s)
actual=$(runner_codex_limit_until "$(fixture codex-runtime-usage-limit)")
assert_rc 0 "$?" "codex reports a reset time from the error message"
assert_eq "$expected" "$actual" "codex parses the human-readable retry time"

actual=$(runner_codex_limit_until "$(fixture codex-synthetic-limit)")
assert_rc 1 "$?" "codex stays silent without a retry time"
assert_eq "" "$actual" "codex prints nothing when the time is unknown"

# Метод опциональный: раннер, который срока не знает, его просто не объявляет,
# и контракт от этого не рвётся (проверка контракта — в contract/).
if declare -F runner_kimi_limit_until >/dev/null 2>&1; then
  test_note "kimi объявил limit_until — проверь, что он читает реальный срок"
fi
test_ok "limit_until is optional for runners that cannot know the reset time"

finish_tests
