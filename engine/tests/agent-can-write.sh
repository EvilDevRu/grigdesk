#!/usr/bin/env bash
# Живой смоук: агент профиля РЕАЛЬНО может выставить статус этапа.
#
# Статическая проверка путей (tests/profile-access.py) этого не ловит: доступ к каталогу и
# одобрение bash-команды — разные механизмы. Инцидент t8060: агент отработал 19 минут, а на
# последнем шаге не смог записать статус — движок счёл этап незавершённым и запустил заново.
#
# Запуск: bash tests/agent-can-write.sh [профиль ...]   (по умолчанию — все)
# Стоит копейки: пустой промпт на самой дешёвой модели.
set -uo pipefail
FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
export STATE_DIR="${FACTORY_STATE:-$HOME/.factory/state}"
mkdir -p "$STATE_DIR"

PROFILES=("$@")
if [[ ${#PROFILES[@]} -eq 0 ]]; then
  mapfile -t PROFILES < <(cd "$FACTORY_HOME/profiles" && ls *.sh | sed 's/\.sh$//')
fi

RC=0
for prof in "${PROFILES[@]}"; do
  ( # подоболочка: профили не должны видеть переменные друг друга
    source "$FACTORY_HOME/lib/core.sh"
    source "$FACTORY_HOME/profiles/${prof}.sh" 2>/dev/null

    task="9999"
    rm -f "$STATE_DIR/t${task}.pipeline"
    prompt="Выполни ровно одну команду: bash $FACTORY_HOME/lib/pipeline-set.sh ${task} PROBE ok
(переменная STATE_DIR=$STATE_DIR уже задана в окружении). Затем ответь одним словом: ГОТОВО."

    cd "${PROFILE_AGENT_CWD:-$HOME}" 2>/dev/null || true
    timeout 180 claude -p "$prompt" --model haiku \
      --settings "$(_agent_settings)" \
      --add-dir "$STATE_DIR" --add-dir "$FACTORY_HOME" ${PROFILE_AGENT_DIRS:+--add-dir $PROFILE_AGENT_DIRS} \
      --permission-mode acceptEdits --output-format json >/dev/null 2>&1

    if grep -q '^PROBE=ok' "$STATE_DIR/t${task}.pipeline" 2>/dev/null; then
      echo "✓ ${prof}: агент выставил статус этапа (cwd=${PROFILE_AGENT_CWD:-$HOME})"
      rm -f "$STATE_DIR/t${task}.pipeline"
      exit 0
    fi
    echo "✗ ${prof}: агент НЕ смог выставить статус — конвейер будет крутить этапы впустую"
    rm -f "$STATE_DIR/t${task}.pipeline"
    exit 1
  ) || RC=1
done

[[ $RC -eq 0 ]] && echo "ИТОГ: агенты всех профилей пишут статусы" || echo "ИТОГ: ЕСТЬ ПРОБЛЕМЫ"
exit $RC
