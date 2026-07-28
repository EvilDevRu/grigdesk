#!/usr/bin/env bash
# Скорость конвейера профиля: заявлены ли веер, бюджет и модели по этапам.
# Без них конвейер идёт одним агентом на самой дорогой модели и копает до таймаута.
# Запуск: bash tests/profile-speed.sh <профиль>
set -uo pipefail
FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
export STATE_DIR="${FACTORY_STATE:-$HOME/.factory/state}"
prof="${1:?укажи профиль}"

source "$FACTORY_HOME/lib/core.sh" 2>/dev/null
source "$FACTORY_HOME/profiles/${prof}.sh" 2>/dev/null

declare -F profile_stage_budget >/dev/null || echo "⚠ нет profile_stage_budget — агенты будут копать до таймаута"
declare -F profile_stage_model  >/dev/null || echo "⚠ нет profile_stage_model — весь конвейер на самой дорогой модели"

if ! declare -F profile_stage_fanout >/dev/null; then
  echo "⚠ нет profile_stage_fanout — все этапы пойдут одним агентом последовательно"
  exit 0
fi

auto=0; fix=0; none=0; nobudget=()
for v in $(compgen -A variable | grep '^PROFILE_ROUTE_STAGES_'); do
  n="$v[@]"
  for s in ${!n}; do
    [[ "$s" == GATE_* ]] && continue
    f=$(profile_stage_fanout "$s" 2>/dev/null)
    case "$f" in
      AUTO*) auto=$((auto+1)) ;;
      "")    none=$((none+1)) ;;
      *)     fix=$((fix+1)) ;;
    esac
    if declare -F profile_stage_budget >/dev/null && [[ -z "$(profile_stage_budget "$s" 2>/dev/null)" ]]; then
      nobudget+=("$s")
    fi
  done
done

echo "✓ параллельность: динамический веер у $auto этап(ов), фиксированный у $fix, без веера $none"
if ((${#nobudget[@]})); then
  # Дубли не страшны: этап может встречаться в нескольких маршрутах
  uniq_list=$(printf '%s\n' "${nobudget[@]}" | sort -u | tr '\n' ' ')
  echo "⚠ без бюджета времени: $uniq_list— эти этапы будут копать до таймаута"
fi
