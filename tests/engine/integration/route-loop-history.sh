#!/usr/bin/env bash
# Режим «цикл» через настоящий launcher: длинная история находок. Проекция находок
# нескольких этапов больше предела одной строки argv (128 КиБ) — launcher отдаёт её
# построителю контекста файлом, а в промпт узла история идёт ограниченной.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

# --- Длинная история находок: семь этапов с развёрнутыми находками ------------------
# 20 находок ведущего на этап по 400 кириллических символов: 120 закрытых и 20 открытых —
# проекция больше предела одной строки argv. Цикл обязан дойти до ворот, а промпт узла —
# остаться в пределе строки argv: раннер получает его тоже аргументом.
task=7103
sed "s/7101/$task/g" "$TEST_ROOT/ticket.json" >"$TEST_ROOT/ticket-$task.json"
write_profile 20
: >"$LOOP_CALLS"
: >"$LOOP_FINDINGS"
python3 - "$LOOP_SCRIPT" <<'PY'
import sys

text = "Ж" * 400
lines = []
for stage in range(1, 8):
    findings = ";".join(f"s{stage}-f{index}={text} {stage}.{index}" for index in range(1, 21))
    closes = ",".join(f"s{stage - 1}-f{index}" for index in range(1, 21)) if stage > 1 else ""
    lines.append(f"REVIEW|failed|build|{findings}|{closes}")
    lines.append("BUILD|done|||")
lines.append("REVIEW|done|||")
with open(sys.argv[1], "w", encoding="utf-8") as target:
    target.write("\n".join(lines) + "\n")
PY
LAUNCH_TIMEOUT=600 launch "$TEST_ROOT/history-start.log" start --profile demo-profile \
  --route loop --ticket-json "$TEST_ROOT/ticket-$task.json"
history_rc=$?
assert_rc 0 "$history_rc" "семь этапов с длинной историей находок проходят launcher"
if (( history_rc != 0 )); then
  tail -20 "$TEST_ROOT/history-start.log"
fi
assert_eq '' "$(cat "$LOOP_SCRIPT")" "сценарий семи этапов пройден целиком"
assert_eq waiting "$(registry_value GATE_ACCEPT)" "длинный цикл дошёл до ворот приёмки"
assert_eq 7 "$(registry_value LOOP_STAGE)" "все шесть границ этапа признаны"
assert_eq '' "$(grep -rh 'Argument list too long' "$state/logs" 2>/dev/null)" \
  "ни сборка контекста, ни запуск раннера не упираются в предел аргумента"
projection=$(find "$control" -path "*t${task}*" -name 'event.*.json' -exec cat {} + | wc -c)
(( projection > 131072 ))
assert_rc 0 "$?" "журнал этапов несёт историю больше строки argv ($projection байт)"
read -r _ last_open last_closed last_omitted last_prompt <<<"$(tail -n 1 "$LOOP_FINDINGS")"
assert_eq 20 "$last_open" "ведущий видит все открытые находки последнего этапа"
assert_eq 120 "$(( last_closed + last_omitted ))" "закрытые — свежие целиком, прочие названы числом"
(( last_omitted > 0 && last_prompt < 100 * 1024 ))
assert_rc 0 "$?" "история в промпте ограничена ($last_closed закрытых, промпт $last_prompt байт)"

finish_tests
