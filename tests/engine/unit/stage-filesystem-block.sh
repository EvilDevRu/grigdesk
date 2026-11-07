#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# Правила записи проверяющего узла обязаны доезжать до самого агента. Пока они жили только
# в правах и стороже, узел перевода диагноза склеивал файлы через `cp`, `tee` и относительный
# путь после `cd`, получил пять отказов, закрыл этап failed и остановил маршрут у человека,
# хотя разрешённый способ (`cat` в абсолютный путь) был под рукой.

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture" "$TEST_ROOT/work"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' \
  'MODEL_TRANSLATOR_ALPHA_FAMILY=fixture' \
  'MODEL_TRANSLATOR_ALPHA_VERSION=latest' \
  'MODEL_TRANSLATOR_ALPHA_EFFORT=high' >"$FACTORY_PROFILES_DIR/fixture/runners.env"

PROFILE_NAME=fixture
PROFILE_CTX=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"

source "$FACTORY_HOME/lib/core.sh"

# run_agent отдаёт собранный промпт раннеру — перехватываем его на этом шаге.
multi_runner_run() {
  printf '%s' "$2" >"$TEST_ROOT/prompt"
  return 0
}

prompt_for() {
  rm -f -- "$TEST_ROOT/prompt"
  FACTORY_ROUTE_FILESYSTEM_POLICY="$1" run_agent 41 'переведи диагноз' TRANSLATOR \
    >/dev/null 2>&1
  cat -- "$TEST_ROOT/prompt"
}

title='Запись файлов на проверяющем узле'

# --- проверяющий узел получает правила записи с буквальным каталогом состояния ---
prompt=$(prompt_for state-only)
assert_contains "$prompt" 'переведи диагноз' "исходное задание узла не потеряно"
assert_contains "$prompt" "$title" "проверяющий узел получает правила записи"
assert_contains "$prompt" "cat <откуда> > $STATE_DIR/<куда>" \
  "рецепт копии называет каталог состояния буквально"
assert_contains "$prompt" "cd $STATE_DIR && cat > файл" \
  "ловушка относительного пути после cd названа прямо"
assert_contains "$prompt" 'с префиксом `t41.`' "свои файлы — с префиксом задачи"
case "$prompt" in
  *'@STATE_DIR@'* | *'@TASK@'*)
    test_fail "метки блока подставлены везде" "$prompt"
    ;;
  *)
    test_ok "метки блока подставлены везде"
    ;;
esac

# --- пишущему узлу блок не нужен: его права ничего из перечисленного не закрывают ---
for policy in workspace-write transactional-write ''; do
  prompt=$(prompt_for "$policy")
  case "$prompt" in
    *"$title"*)
      test_fail "узел с политикой «${policy:-нет}» блок не получает" "$prompt"
      ;;
    *)
      test_ok "узел с политикой «${policy:-нет}» блок не получает"
      ;;
  esac
done

# --- блок не врёт о правах: названное запрещённым запрещено, рецепт исполним ---
settings=$(cat "$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only _agent_settings TRANSLATOR 41)")
for rule in 'Bash(cp:*)' 'Bash(mv:*)' 'Bash(rm:*)' 'Bash(tee:*)' 'Bash(sed -i:*)' \
  'Bash(python3 -c:*)' 'Bash(xargs:*)' 'Bash(timeout:*)'; do
  assert_contains "$settings" "\"$rule\"" "блок называет запрещённым то, что запрещено правами: $rule"
done
assert_contains "$settings" '"Bash(cat:*)"' "рецепт копии исполним: cat разрешён"
copy=$(printf '{"tool_input":{"command":"cat %s/t41.diag.md > %s/t41.diag.raw.md"}}' \
  "$STATE_DIR" "$STATE_DIR" | bash "$FACTORY_HOME/lib/stage-write-guard.sh" "$STATE_DIR")
assert_eq '' "$copy" "рецепт копии проходит сторож записи"

finish_tests
