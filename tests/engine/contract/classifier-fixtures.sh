#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/runners/claude.sh lib/runners/codex.sh lib/runners/kimi.sh lib/runners/deepseek.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/executor.sh"
runner_registry_reset
runner_registry_add claude "$FACTORY_HOME/lib/runners/claude.sh"
runner_registry_add codex "$FACTORY_HOME/lib/runners/codex.sh"
runner_registry_add kimi "$FACTORY_HOME/lib/runners/kimi.sh"
runner_registry_add deepseek "$FACTORY_HOME/lib/runners/deepseek.sh"
runner_contract_check claude
assert_rc 0 "$?" "Claude module passes runner contract"
runner_contract_check codex
assert_rc 0 "$?" "Codex module passes runner contract"
runner_contract_check kimi
assert_rc 0 "$?" "Kimi module passes runner contract"
runner_contract_check deepseek
assert_rc 0 "$?" "DeepSeek module passes runner contract"
runner_call claude probe >/dev/null 2>&1
assert_rc 126 "$?" "Claude probe cannot escape offline executor"
runner_call codex probe >/dev/null 2>&1
assert_rc 126 "$?" "Codex probe cannot escape offline executor"
runner_call kimi probe >/dev/null 2>&1
assert_rc 126 "$?" "Kimi probe cannot escape offline executor"
runner_call deepseek probe >/dev/null 2>&1
assert_rc 126 "$?" "DeepSeek probe cannot escape offline executor"

# Пин проводки: OFFLINE_GUARD в engine/lib/executor.sh пока не знает basename
# kimi (пункт `kimi|kimi-*` из плана). Тест RED до обновления executor.sh:
# сейчас stub отрабатывает с rc=0 вместо блокировки 126.
for name in kimi kimi-beta; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$TEST_ROOT/$name"
  chmod +x "$TEST_ROOT/$name"
  factory_exec local "$TEST_ROOT/$name" >/dev/null 2>&1
  assert_rc 126 "$?" "$name basename denied even when mislabeled local"
done
for name in dsh dsh-beta; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$TEST_ROOT/$name"
  chmod +x "$TEST_ROOT/$name"
  factory_exec local "$TEST_ROOT/$name" >/dev/null 2>&1
  assert_rc 126 "$?" "$name basename denied even when mislabeled local"
done

fixture_root="$TEST_ROOT/classifier-fixtures"
mkdir -p "$fixture_root"

materialize_fixture() {
  local name=$1 source="$FACTORY_TESTS_HOME/fixtures/classifiers/$1" target="$fixture_root/$1"
  cp -a "$source" "$target"
  case "$name" in
    claude-synthetic-limit)
      printf 'You have reached your 5-hour usage limit.\n' >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    claude-runtime-session-limit|codex-runtime-usage-limit|codex-capacity|kimi-ok|kimi-interrupted)
      : >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    codex-synthetic-limit)
      printf 'usage limit reached\n' >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    codex-denied)
      printf 'sandbox denied write access\n' >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    kimi-no-login|kimi-auth-after-work)
      printf '%s\n' \
        'error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.' \
        'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
        >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    kimi-usage-limit)
      printf '%s\n' \
        "error: failed to run prompt: provider.auth_error: 403 You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing" \
        'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
        >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    kimi-oauth-transport)
      printf '%s\n' \
        'error: failed to run prompt: internal: OAuth request to https://auth.kimi.com/api/oauth/token failed: fetch failed: Client network socket disconnected before secure TLS connection was established' \
        'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
        >"$target/stderr.log"
      : >"$target/stdout.log" ;;
    kimi-bad-model)
      printf '%s\n' \
        'error: failed to run prompt: config.invalid: Model "kimi-code/no-such-model-zz" is not configured in config.toml. Add a [models."kimi-code/no-such-model-zz"] entry with max_context_size.' \
        'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
        >"$target/stderr.log"
      : >"$target/stdout.log" ;;
  esac
  printf '%s\n' "$target"
}

check_fixture() {
  local provider=$1 name=$2 dir expected actual rc
  dir=$(materialize_fixture "$name")
  for required in meta.env stderr.log stdout.log events.jsonl; do
    assert_file_exists "$dir/$required" "$name contains $required"
  done
  expected=$(awk -F= '$1=="EXPECTED_CLASS"{print $2}' "$dir/meta.env")
  rc=$(awk -F= '$1=="RC"{print $2}' "$dir/meta.env")
  actual=$(runner_call "$provider" classify "$dir" "$rc")
  assert_eq "$expected" "$actual" "$name classifies as expected"
}

check_fixture claude claude-synthetic-limit
check_fixture claude claude-auth-expired
check_fixture claude claude-auth-corrupt-stream
check_fixture claude claude-request-not-allowed
check_fixture claude claude-request-not-allowed-after-work
check_fixture claude claude-context-overflow
check_fixture claude claude-weekly-limit
check_fixture claude claude-runtime-weekly-limit
check_fixture claude claude-runtime-session-limit
check_fixture claude claude-rate-limit
check_fixture codex codex-synthetic-limit
check_fixture codex codex-runtime-usage-limit
check_fixture codex codex-denied
check_fixture codex codex-auth-expired
check_fixture codex codex-auth-corrupt-stream
check_fixture codex codex-context-overflow
check_fixture codex codex-capacity
check_fixture kimi kimi-ok
check_fixture kimi kimi-no-login
check_fixture kimi kimi-bad-model
check_fixture kimi kimi-interrupted
check_fixture kimi kimi-auth-after-work
check_fixture kimi kimi-usage-limit
check_fixture kimi kimi-oauth-transport
check_fixture deepseek deepseek-ok
check_fixture deepseek deepseek-timeout
check_fixture deepseek deepseek-auth-no-work
check_fixture deepseek deepseek-auth-after-work
check_fixture deepseek deepseek-truncated
check_fixture deepseek deepseek-unknown

deepseek_unverified="$TEST_ROOT/deepseek-unverified"
cp -a "$fixture_root/deepseek-auth-no-work" "$deepseek_unverified"
sed -i 's/FIXTURE_VERIFIED=.*/FIXTURE_VERIFIED=0/; s/SOURCE=.*/SOURCE=fixture/' \
  "$deepseek_unverified/meta.env"
actual=$(runner_call deepseek classify "$deepseek_unverified" 1)
assert_eq unknown "$actual" "unverified DeepSeek auth text fails closed"

for ambiguous in 413 429; do
  deepseek_ambiguous="$TEST_ROOT/deepseek-$ambiguous"
  cp -a "$fixture_root/deepseek-unknown" "$deepseek_ambiguous"
  printf 'provider returned %s\n' "$ambiguous" >"$deepseek_ambiguous/stderr.log"
  actual=$(runner_call deepseek classify "$deepseek_ambiguous" 1)
  assert_eq unknown "$actual" "DeepSeek $ambiguous stays unknown without a proven retry contract"
done

unknown="$TEST_ROOT/unknown-version"
cp -a "$fixture_root/codex-denied" "$unknown"
sed -i 's/CLI_VERSION=.*/CLI_VERSION=999.0.0/' "$unknown/meta.env"
actual=$(runner_call codex classify "$unknown" 1)
assert_eq denied "$actual" "new Codex semver preserves a proven permission failure"

# Обновление CLI не меняет смысл того же терминального события. Ошибка внутри
# вывода инструмента, наоборот, не является отказом провайдера ни при какой версии.
codex_tool_text="$TEST_ROOT/codex-tool-text"
cp -a "$fixture_root/codex-runtime-usage-limit" "$codex_tool_text"
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution",'\
'"aggregated_output":"You have hit your usage limit. purchase more credits"}}' \
  >"$codex_tool_text/events.jsonl"
actual=$(runner_call codex classify "$codex_tool_text" 1)
assert_eq unknown "$actual" "tool output cannot open a Codex quota breaker"

for version in 0.145.0 0.159.2 999.0.0; do
  codex_capacity="$TEST_ROOT/codex-capacity-$version"
  cp -a "$fixture_root/codex-capacity" "$codex_capacity"
  sed -i "s/CLI_VERSION=.*/CLI_VERSION=$version/" "$codex_capacity/meta.env"
  actual=$(runner_call codex classify "$codex_capacity" 1)
  assert_eq transient "$actual" "Codex capacity after work is transient on $version"
done

kimi_unknown="$TEST_ROOT/kimi-unknown-version"
cp -a "$fixture_root/kimi-no-login" "$kimi_unknown"
sed -i 's/CLI_VERSION=.*/CLI_VERSION=999.0.0/' "$kimi_unknown/meta.env"
actual=$(runner_call kimi classify "$kimi_unknown" 1)
assert_eq provider_unavailable "$actual" \
  "new Kimi semver preserves a proven no-activity classifier signature"

# Тот же 403 без текста про квоту — это отозванный/неверный токен: ожиданием он не
# лечится, предохранителю его отдавать нельзя.
kimi_auth_403="$TEST_ROOT/kimi-auth-403"
cp -a "$fixture_root/kimi-usage-limit" "$kimi_auth_403"
printf '%s\n' \
  'error: failed to run prompt: provider.auth_error: 403 Forbidden' \
  'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
  >"$kimi_auth_403/stderr.log"
actual=$(runner_call kimi classify "$kimi_auth_403" 1)
assert_eq unknown "$actual" "Kimi 403 without a quota signature fails closed"

# Лимит, догнавший уже работавшую модель, лимитом для предохранителя не считается:
# иначе следующий заход переиграет частично выполненный ход (fixture kimi-auth-after-work).
kimi_limit_after_work="$TEST_ROOT/kimi-limit-after-work"
cp -a "$fixture_root/kimi-usage-limit" "$kimi_limit_after_work"
cp -a "$fixture_root/kimi-auth-after-work/events.jsonl" "$kimi_limit_after_work/events.jsonl"
actual=$(runner_call kimi classify "$kimi_limit_after_work" 1)
assert_eq unknown "$actual" "Kimi quota limit after model activity stays unknown"

# Обрыв транспорта на токене признаётся только по ОБЕИМ частям сигнатуры. Один
# `OAuth request … failed` покрывает и отозванный токен: тот ожиданием не лечится и
# `transient` про него сказал бы неправду.
kimi_oauth_denied="$TEST_ROOT/kimi-oauth-denied"
cp -a "$fixture_root/kimi-oauth-transport" "$kimi_oauth_denied"
printf '%s\n' \
  'error: failed to run prompt: internal: OAuth request to https://auth.kimi.com/api/oauth/token failed: 401 invalid_grant' \
  'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
  >"$kimi_oauth_denied/stderr.log"
actual=$(runner_call kimi classify "$kimi_oauth_denied" 1)
assert_eq unknown "$actual" "Kimi OAuth refusal without a transport signature fails closed"

# Обрыв соединения САМ ПО СЕБЕ ничего не доказывает: те же слова печатает провайдер
# модели, а это уже другой отказ с другой ценой.
kimi_bare_transport="$TEST_ROOT/kimi-bare-transport"
cp -a "$fixture_root/kimi-oauth-transport" "$kimi_bare_transport"
printf '%s\n' \
  'error: failed to run prompt: internal: fetch failed: Client network socket disconnected before secure TLS connection was established' \
  'See log: /workspace/example/.kimi-code/logs/kimi-code.log' \
  >"$kimi_bare_transport/stderr.log"
actual=$(runner_call kimi classify "$kimi_bare_transport" 1)
assert_eq unknown "$actual" "Kimi bare transport error without the token endpoint fails closed"

# Работа модели этот класс НЕ отменяет: именно после неё отказ и случается, а
# переключения исполнителя `transient` всё равно не вызывает.
kimi_oauth_fresh="$TEST_ROOT/kimi-oauth-no-activity"
cp -a "$fixture_root/kimi-oauth-transport" "$kimi_oauth_fresh"
printf '%s\n' '{"role":"meta","type":"system.version","version":"0.33.0"}' \
  >"$kimi_oauth_fresh/events.jsonl"
actual=$(runner_call kimi classify "$kimi_oauth_fresh" 1)
assert_eq transient "$actual" "Kimi token transport failure is transient with or without model activity"

# Непроверенная fixture из неизвестного источника класса не получает: текст ошибки
# приходит от чужого CLI, и доверять ему на слово нельзя.
kimi_oauth_unverified="$TEST_ROOT/kimi-oauth-unverified"
cp -a "$fixture_root/kimi-oauth-transport" "$kimi_oauth_unverified"
sed -i 's/FIXTURE_VERIFIED=.*/FIXTURE_VERIFIED=0/' "$kimi_oauth_unverified/meta.env"
actual=$(runner_call kimi classify "$kimi_oauth_unverified" 1)
assert_eq unknown "$actual" "unverified Kimi OAuth fixture fails closed"

kimi_unverified="$TEST_ROOT/kimi-unverified-fixture"
cp -a "$fixture_root/kimi-no-login" "$kimi_unverified"
sed -i 's/FIXTURE_VERIFIED=.*/FIXTURE_VERIFIED=0/' "$kimi_unverified/meta.env"
actual=$(runner_call kimi classify "$kimi_unverified" 1)
assert_eq unknown "$actual" "unverified Kimi fixture fails closed"

actual=$(bash --noprofile --norc -c \
  'source "$FACTORY_HOME/lib/runners/codex.sh"; runner_codex_classify "$1" 1' \
  _ "$fixture_root/codex-denied")
assert_eq denied "$actual" "Codex classifier works standalone"

finish_tests
