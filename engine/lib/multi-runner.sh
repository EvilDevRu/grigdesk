#!/usr/bin/env bash

# Provider-neutral orchestration. Каждый профиль обязан иметь валидный
# profiles/<name>/runners.env; скрытого provider по умолчанию нет.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/profile-config.sh"
source "$FACTORY_HOME/lib/routing.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runners/catalog.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/dispatcher.sh"
source "$FACTORY_HOME/lib/runtime-switch.sh"
source "$FACTORY_HOME/lib/coverage.sh"
source "$FACTORY_HOME/lib/adapters/index.sh"
source "$FACTORY_HOME/lib/execution-plan.sh"

multi_runner_config_file() {
  local profiles_dir=${FACTORY_PROFILES_DIR:-"$(cd "$FACTORY_HOME/.." && pwd)/profiles"}
  printf '%s/%s/runners.env\n' "$profiles_dir" "${PROFILE_NAME:?PROFILE_NAME}"
}

_multi_provider_key() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

_multi_model_value() {
  local config=$1 stage=$2 provider=$3 suffix=$4 provider_key
  provider_key=$(_multi_provider_key "$provider")
  local value
  value=$(profile_config_get "$config" "MODEL_${stage}_${provider_key}_${suffix}")
  [[ -n "$value" ]] || value=$(profile_config_get "$config" "MODEL_DEFAULT_${provider_key}_${suffix}")
  printf '%s\n' "$value"
}

_multi_catalog_model() {
  local provider=$1 family=$2 version=$3 variant=$4 exact=$5
  local runner_version=${6:-1.0.0}
  local catalog_file rc model snapshot_dir active_root active_revision active_snapshot
  MULTI_CATALOG_REVISION=""
  active_root="${STATE_DIR:?}/runners/catalogs/$provider"
  active_revision=$(head -1 "$active_root/active" 2>/dev/null | tr -d '[:space:]')
  active_snapshot="$active_root/revisions/$active_revision"
  if [[ "$active_revision" =~ ^[A-Za-z0-9._-]+$ && -s "$active_snapshot/models.tsv" ]]; then
    catalog_file="$active_snapshot/models.tsv"
    snapshot_dir=$active_snapshot
    MULTI_CATALOG_REVISION=$active_revision
  else
    catalog_file="$MULTI_CATALOG_ROOT/$provider.models.tsv"
    if [[ ! -f "$MULTI_CATALOG_ROOT/$provider.attempted" ]]; then
      : >"$MULTI_CATALOG_ROOT/$provider.attempted"
      runner_call "$provider" catalog >"$catalog_file" 2>/dev/null || rm -f -- "$catalog_file"
    fi
    snapshot_dir="$MULTI_CATALOG_ROOT/$provider.snapshot"
  fi
  if [[ -s "$catalog_file" ]]; then
    if [[ "$catalog_file" != */models.tsv ]]; then
      mkdir -p "$snapshot_dir"
      cp -- "$catalog_file" "$snapshot_dir/models.tsv"
    fi
    if [[ -n "$exact" ]]; then
      model=$(catalog_resolve_exact "$snapshot_dir" "$provider" "$exact" "$runner_version" 2>/dev/null)
      rc=$?
    else
      model=$(catalog_resolve "$snapshot_dir" "$provider" "$family" \
        "${version:-latest}" "${variant:-auto}" "$runner_version" 2>/dev/null)
      rc=$?
    fi
    if [[ "$snapshot_dir" == "$MULTI_CATALOG_ROOT/"* ]]; then
      rm -f -- "$snapshot_dir/models.tsv"
      rmdir "$snapshot_dir" 2>/dev/null || true
    fi
    [[ $rc -eq 0 ]] && {
      [[ -n "${MULTI_CATALOG_REVISION:-}" ]] || MULTI_CATALOG_REVISION=runner-live
      MULTI_RESOLVED_MODEL=$model
      return 0
    }
    return "$rc"
  fi

  # Без каталога допускается только provider-owned семейный alias. Exact id обязан
  # присутствовать в проверенном snapshot: иначе опечатка или снятая модель обнаружатся
  # уже после начала этапа и могут ошибочно выглядеть как сбой provider-а.
  if [[ -n "$exact" ]]; then
    return 4
  fi
  [[ -n "$family" ]] || return 4
  if declare -F "runner_${provider}_family_alias" >/dev/null &&
     "runner_${provider}_family_alias" "$family"; then
    MULTI_RESOLVED_MODEL=$family
    MULTI_CATALOG_REVISION=provider-alias
    return 0
  fi
  return 4
}

_multi_catalog_cleanup() {
  local root=${MULTI_CATALOG_ROOT:-}
  [[ -n "$root" && "$root" == "${STATE_DIR:?}"/.catalog-invoke.* ]] || return 2
  rm -f -- "$root"/*.models.tsv "$root"/*.attempted
  rmdir "$root" 2>/dev/null || true
}

_multi_execution_plan() {
  # Этапу нужен терминальный status transport, а его реализация provider-specific:
  # Claude сохраняет capability FD, Codex использует deferred request из sandbox.
  local provider=$1 caps required=status degradable="" requirements plan
  local fanout_mode=${FACTORY_ROUTE_FANOUT_MODE:-single}
  local fanout_max=${FACTORY_ROUTE_FANOUT_MAX:-1}
  local fanout_degrade=${FACTORY_ROUTE_FANOUT_DEGRADE:-forbid}
  case "$fanout_mode:$fanout_max:$fanout_degrade" in
    single:1:forbid) ;;
    parallel:*:forbid)
      [[ "$fanout_max" =~ ^([2-9]|1[0-6])$ ]] || return 78
      required=$(_execution_csv_append_unique "$required" fanout)
      ;;
    parallel:*:allow-single)
      [[ "$fanout_max" =~ ^([2-9]|1[0-6])$ ]] || return 78
      required=$(_execution_csv_append_unique "$required" fanout)
      degradable=$(_execution_csv_append_unique "$degradable" fanout)
      ;;
    *) return 78 ;;
  esac
  caps=$(runner_call "$provider" capabilities 2>/dev/null | tr ' \n' ',' | sed 's/,,*/,/g; s/,$//')
  requirements=$(mktemp "$MULTI_CATALOG_ROOT/.requirements.XXXXXX")
  {
    printf 'REQUIREMENTS_SCHEMA=1\n'
    printf 'REQUIRED_CAPS=%s\n' "$required"
    printf 'DEGRADABLE_CAPS=%s\n' "$degradable"
  } >"$requirements"
  adapter_registry_reset
  plan=$(execution_plan_build "$requirements" "$caps" "")
  rm -f -- "$requirements"
  MULTI_PLAN_LEVEL["$provider"]=$(awk -F= '$1=="PLAN_LEVEL"{print $2}' <<<"$plan")
  MULTI_PLAN_DEGRADED["$provider"]=$(awk -F= '$1=="PLAN_DEGRADED"{print $2}' <<<"$plan")
  [[ "${MULTI_PLAN_LEVEL[$provider]}" != unavailable ]]
}

_multi_resolve() {
  local provider=$1 requested_family=${2:-}
  local config family version variant effort exact fallback provider_key auth_profile
  local probe_output runner_version
  config=$(multi_runner_config_file)
  runner_registry_has "$provider" || {
    DISPATCH_RESOLVE_RESULT=route_unavailable
    return 4
  }
  if [[ "${MULTI_PROBE_READY[$provider]:-0}" != 1 ]]; then
    probe_output=$(runner_call "$provider" probe 2>/dev/null) || {
      DISPATCH_RESOLVE_RESULT=unavailable_preflight
      return 4
    }
    runner_version=$(grep -oE '[0-9]+([.][0-9]+)+' <<<"$probe_output" | head -1)
    [[ -n "$runner_version" ]] || runner_version=1.0.0
    MULTI_PROBE_READY["$provider"]=1
    MULTI_PROBE_VERSION["$provider"]=$runner_version
  fi
  runner_version=${MULTI_PROBE_VERSION[$provider]}
  _multi_execution_plan "$provider" || {
    DISPATCH_RESOLVE_RESULT=route_unavailable
    return 4
  }
  family=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" FAMILY)
  version=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" VERSION)
  variant=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" VARIANT)
  effort=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" EFFORT)
  exact=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" EXACT)
  fallback=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" FAMILY_FAILOVER)
  [[ -z "$requested_family" ]] || {
    family=$requested_family
    exact=""
  }
  [[ -n "$version" ]] || version=latest
  [[ -n "$variant" ]] || variant=auto
  [[ -n "$effort" ]] || effort=high
  if [[ -z "$family" && -z "$exact" ]] &&
     declare -F "runner_${provider}_default_policy" >/dev/null; then
    local defaults
    defaults=$("runner_${provider}_default_policy" "$MULTI_STAGE")
    family=$(awk -F= '$1=="FAMILY"{print $2}' <<<"$defaults")
    version=$(awk -F= '$1=="VERSION"{print $2}' <<<"$defaults")
    variant=$(awk -F= '$1=="VARIANT"{print $2}' <<<"$defaults")
    effort=$(awk -F= '$1=="EFFORT"{print $2}' <<<"$defaults")
  fi
  if ! _multi_catalog_model "$provider" "$family" "$version" "$variant" "$exact" "$runner_version"; then
    if [[ -n "$exact" ]]; then
      DISPATCH_RESOLVE_RESULT=invalid_config
    else
      DISPATCH_RESOLVE_RESULT=route_unavailable
    fi
    return 4
  fi
  provider_key=$(_multi_provider_key "$provider")
  auth_profile=$(profile_config_get "$config" "RUNNER_${provider_key}_AUTH_PROFILE")
  DISPATCH_RESOLVED_FAMILY=${family:-exact}
  DISPATCH_RESOLVED_MODEL=$MULTI_RESOLVED_MODEL
  DISPATCH_RESOLVED_EFFORT=$effort
  DISPATCH_RUNNER_VERSION=$runner_version
  DISPATCH_FAMILY_FAILOVER=$fallback
  DISPATCH_CREDENTIAL_FINGERPRINT=$(
    printf '%s|%s' "$provider" "${auth_profile:-default}" | sha256sum | awk '{print substr($1,1,24)}'
  )
}

_multi_new_id() {
  local uuid
  uuid=$(head -1 /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '[:space:]')
  if [[ "$uuid" =~ ^[0-9a-f-]{36}$ ]]; then
    printf 'r%s\n' "$uuid"
  else
    printf 'r%s-%s-%s\n' "$(date +%s%N)" "$$" "$RANDOM"
  fi
}

_multi_new_token() {
  local random
  random=$(od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  printf '%s|%s|%s|%s' "$random" "$RANDOM" "$$" "$(date +%s%N)" |
    sha256sum | awk '{print $1}'
}

_multi_request_matches() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 request active
  request=$(_runtime_switch_file "$task" "$stage")
  active=$(run_state_active_file "$task" "$stage")
  [[ -f "$request" &&
     "$(_run_state_get "$active" STATE)" == active &&
     "$(_run_state_get "$active" RUN_ID)" == "$run_id" &&
     "$(_run_state_get "$active" EPOCH)" == "$epoch" &&
     "$(_run_state_get "$request" STATE)" == pending &&
     "$(_run_state_get "$request" RUN_ID)" == "$run_id" &&
     "$(_run_state_get "$request" EPOCH)" == "$epoch" ]]
}

_multi_invoke() {
  local provider=$1 family=$2 model=$3
  local run_id epoch token run_dir rc result request_id target fanout_count active_reason
  if ! runner_call "$provider" probe >/dev/null 2>&1; then
    DISPATCH_INVOKE_RESULT=unavailable_preflight
    DISPATCH_INVOKE_STARTED=0
    return 0
  fi

  epoch=$(get "$MULTI_TASK" "ACTIVE_EPOCH_${MULTI_STAGE}")
  [[ "$epoch" =~ ^[0-9]+$ ]] || epoch=0
  # Счётчик из реестра — provider-writable и может отстать: новый start после
  # abandon создаёт чистый реестр, и эпохи откатывались бы к 1 против уже
  # записанных в доверенном run-state — тогда run_state_begin отбивает КАЖДЫЙ
  # запуск кодом 73 и задача не стартует вовсе.
  # Доверенный control plane — источник истины: берём максимум, эпоха не убывает.
  local trusted_file trusted_epoch
  trusted_file=$(run_state_active_file "$MULTI_TASK" "$MULTI_STAGE" 2>/dev/null || true)
  if [[ -n "$trusted_file" && -f "$trusted_file" && ! -L "$trusted_file" ]]; then
    trusted_epoch=$(awk -F= '$1 == "EPOCH" { sub(/^[^=]*=/, ""); print; exit }' "$trusted_file")
    [[ "$trusted_epoch" =~ ^[0-9]+$ ]] && (( trusted_epoch > epoch )) && epoch=$trusted_epoch
  fi
  epoch=$((epoch + 1))
  run_id=$(_multi_new_id)
  token=$(_multi_new_token)
  run_dir="$STATE_DIR/logs/runs/t${MULTI_TASK}/${MULTI_STAGE}/${run_id}"
  run_state_begin "$MULTI_TASK" "$MULTI_STAGE" "$run_id" "$epoch" "$token" || {
    DISPATCH_INVOKE_RESULT=unknown
    DISPATCH_INVOKE_STARTED=0
    return 0
  }
  # Bash передаёт local-переменные вызывающей функции динамически: dispatcher
  # держит здесь доказанную причину перехода (limit/preflight/manual). Публикуем
  # её до запуска provider, иначе весь долгий run Cockpit показывает устаревшую
  # причину предыдущего этапа.
  active_reason=${last_switch_reason:-primary}
  set_st "$MULTI_TASK" "RUNNER_ACTUAL_${MULTI_STAGE}" "$provider" \
    "RUNNER_REASON_${MULTI_STAGE}" "$active_reason" \
    "MODEL_FAMILY_${MULTI_STAGE}" "$family" \
    "MODEL_ACTUAL_${MULTI_STAGE}" "$model" \
    "CATALOG_REVISION_${MULTI_STAGE}" "$MULTI_CATALOG_REVISION" \
    "PLAN_LEVEL_${MULTI_STAGE}" "${MULTI_PLAN_LEVEL[$provider]}"

  local status_command progress_command
  status_command="bash $FACTORY_HOME/lib/stage-result.sh --task $MULTI_TASK --stage $MULTI_STAGE --run-id $run_id --epoch $epoch"
  progress_command="bash $FACTORY_HOME/lib/stage-progress.sh --task $MULTI_TASK --stage $MULTI_STAGE --run-id $run_id --epoch $epoch"
  local plan_note=""
  if [[ "${FACTORY_ROUTE_FANOUT_MODE:-single}" == parallel &&
        "${MULTI_PLAN_LEVEL[$provider]}" != degraded ]]; then
    plan_note="
ПАРАЛЛЕЛЬНЫЙ READ-ONLY ВЕЕР: выдели до ${FACTORY_ROUTE_FANOUT_MAX} независимых исполнителей
для явно разделённых зон задания, затем сам сведи их доказательства в один терминальный
результат. Исполнители не меняют workspace и не публикуют статус этапа по отдельности."
  elif [[ "${MULTI_PLAN_LEVEL[$provider]}" == degraded &&
          "${MULTI_PLAN_DEGRADED[$provider]}" == *fanout* ]]; then
    plan_note="
РЕЖИМ СОВМЕСТИМОСТИ: этот runner не предоставляет нативный fanout. Не блокируй этап:
разбери перечисленные зоны последовательно, сохраняя независимые заметки, затем сведи их
тем же способом. Это явная деградация скорости, а не разрешение пропустить проверку."
  fi
  local prompt="${MULTI_PROMPT}
${plan_note}

ЗАВЕРШЕНИЕ ЭТАПА (единственный допустимый канал статуса этого запуска):
  ${status_command} done
  ${status_command} failed \"причина\"
  ${status_command} --failure-owner build --finding \"stable-id=краткое проверяемое замечание\" failed \"причина\"
  ${status_command} --failure-owner build --finding \"stable-id=замечание\" --finding-anchor \"stable-id=путь/до/файла\" --reviewed \"путь/до/файла\" failed \"причина\"
  ${status_command} skipped \"причина\"
Команда принимает результат только текущего run; старый или повторный результат будет отклонён.
Для проверочного failed типизированные замечания обязательны; bare failed оставлен только
для legacy авторских этапов. Назначь корневого владельца: build — дефект продукта;
tests — дефект/неполнота теста; environment —
стенд, зависимости или конфигурация; plan — неверное требование/план; human — нужно решение
человека. У каждого замечания стабильный id в kebab-case: при повторной проверке сохраняй тот
же id, пока проблема та же, и не включай уже исчезнувшее замечание. Нельзя передавать owner без
хотя бы одного --finding или metadata у done/skipped.
ЛИМИТЫ ЗАМЕЧАНИЙ (нарушение — отказ команды с кодом 2 и названной причиной): id — kebab-case
до 64 символов; summary — ОДНА строка до 500 символов без переводов строки; замечаний не
больше 32. summary — ярлык замечания, а не разбор: доказательства, числа и цитаты кладутся в
файл этапа в STATE_DIR, на который ссылается причина.
ЯКОРЬ И ОХВАТ (проверяющим узлам): --finding-anchor \"id=путь\" называет файл, к которому
относится замечание, а --reviewed \"путь\" перечисляет всё, что ты на этом проходе фактически
просмотрел (относительные пути, до 64 штук). Их читает не человек, а движок: по ним он
отличает первый проход по файлу, созданному предыдущим ремонтом, от новой претензии к уже
проверенному коду. Первый случай маршрут проводит сам, второй останавливает и зовёт человека.
Не объявляй просмотренным то, что не открывал: пропущенный файл потом нельзя будет назвать
новым, и маршрут встанет на ровном месте."
  prompt+="

ПРОГРЕСС И МЕТАДАННЫЕ (не завершает этап):
  ${progress_command} KEY VALUE [KEY VALUE ...]
Так публикуются ROUTE/SIZE и статусы внутренних узлов. Ключ текущего этапа, ворота и
служебные поля этой командой менять нельзя."

  export FACTORY_RUN_TASK="$MULTI_TASK"
  export FACTORY_RUN_STAGE="$MULTI_STAGE"
  export FACTORY_RUN_ID="$run_id"
  export FACTORY_RUN_EPOCH="$epoch"
  export FACTORY_RUNNER_VERSION="${DISPATCH_RUNNER_VERSION:-unknown}"
  export FACTORY_RUN_PROFILE="${PROFILE_NAME:-}"
  export FACTORY_DEBUG_ROUTE_SOURCE="${MULTI_ROUTE_SOURCE:-unknown}"
  export FACTORY_DEBUG_PRIMARY="${MULTI_PRIMARY:-$provider}"
  export FACTORY_DEBUG_FAILOVER="${MULTI_FAILOVER:-}"
  export FACTORY_DEBUG_FAMILY="$family"
  export FACTORY_DEBUG_CATALOG_REVISION="${MULTI_CATALOG_REVISION:-unknown}"
  export FACTORY_DEBUG_PLAN_LEVEL="${MULTI_PLAN_LEVEL[$provider]:-unknown}"
  export FACTORY_DEBUG_REASON="$active_reason"
  runner_launch "$provider" "$MULTI_TASK" "$prompt" "$MULTI_STAGE" "$model" \
    "${DISPATCH_RESOLVED_EFFORT:-high}" "$MULTI_TIMEOUT" "$run_dir" "$run_id" "$epoch" "$token"
  rc=$?
  fanout_count=$(runner_call "$provider" fanout_count "$run_dir" 2>/dev/null)
  [[ "$fanout_count" =~ ^[0-9]+$ ]] || fanout_count=0
  set_st "$MULTI_TASK" "FANOUT_${MULTI_STAGE}" "$fanout_count"

  if _multi_request_matches "$MULTI_TASK" "$MULTI_STAGE" "$run_id" "$epoch"; then
    request_id=$(_run_state_get "$(_runtime_switch_file "$MULTI_TASK" "$MULTI_STAGE")" REQUEST_ID)
    target=$(runtime_switch_consume "$MULTI_TASK" "$MULTI_STAGE" "$run_id" "$epoch" "$request_id") || {
      DISPATCH_INVOKE_RESULT=unknown
      DISPATCH_INVOKE_STARTED=1
      return 0
    }
    # runner-launcher уже записал classifier результата завершённого процесса. При
    # operator switch это не crash/unknown: последняя запись выигрывает в env-parser-е
    # и честно объясняет attempt в Cockpit.
    printf 'RESULT_CLASS=manual_switch\n' >>"$run_dir/meta.env"
    MULTI_MANUAL_TARGET=$target
    DISPATCH_INVOKE_RESULT=manual_switch
    DISPATCH_INVOKE_STARTED=1
    return 0
  fi

  result=$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)
  [[ -n "$result" ]] || result=unknown
  DISPATCH_INVOKE_RESULT=$result
  DISPATCH_INVOKE_STARTED=1
  DISPATCH_LIMIT_SCOPE=provider
  DISPATCH_LIMIT_UNTIL=""
  # Срок сброса спрашиваем только у отказа по лимиту и только у того раннера,
  # который умеет его назвать: метод ОПЦИОНАЛЬНЫЙ, и его отсутствие оставляет
  # предохранителю общий cooldown, а не ломает контракт (docs/engine/ADDING-RUNNER.md).
  if [[ "$result" == limited ]] && declare -F "runner_${provider}_limit_until" >/dev/null 2>&1; then
    local limit_until
    limit_until=$(runner_call "$provider" limit_until "$run_dir" 2>/dev/null) || limit_until=""
    [[ "$limit_until" =~ ^[0-9]+$ ]] && DISPATCH_LIMIT_UNTIL=$limit_until
  fi
  return 0
}

multi_runner_run() {
  local task=$1 prompt=$2 stage=$3 timeout_s=$4
  local config route primary failover rc manual_count=0 switched=0
  config=$(multi_runner_config_file)
  profile_config_validate "$config" || return 78
  if [[ "$(profile_config_get "$config" RUNNERS_COVERAGE)" == required ]]; then
    local coverage_dir expected_revision
    coverage_dir="$STATE_DIR/coverage/${PROFILE_NAME}"
    expected_revision=$(sha256sum "$config" | awk '{print substr($1,1,16)}')
    if ! coverage_gate "$coverage_dir/structural.env" "$coverage_dir/host.env" \
      "$expected_revision" "$(date +%s)"; then
      set_st "$task" STALLED_HUMAN 1 "RUNNER_REASON_${stage}" coverage_unavailable
      return 79
    fi
  fi
  runner_registry_reset
  runner_registry_load "${FACTORY_RUNNERS_DIR:-"$FACTORY_HOME/lib/runners"}" || return 78
  route=$(routing_resolve "$config" "$(_pf "$task")" "$stage") || return 78
  primary=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$route")
  failover=$(awk -F= '$1=="FAILOVER"{print $2}' <<<"$route")
  MULTI_ROUTE_SOURCE=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$route")
  MULTI_PRIMARY=$primary
  MULTI_FAILOVER=$failover
  set_st "$task" "RUNNER_REQUESTED_${stage}" "$primary" \
    "RUNNER_FAILOVER_${stage}" "$failover"
  MULTI_TASK=$task
  MULTI_STAGE=$stage
  MULTI_PROMPT=$prompt
  MULTI_TIMEOUT=$timeout_s
  MULTI_MANUAL_TARGET=""
  MULTI_CATALOG_REVISION=""
  declare -gA MULTI_PROBE_READY=()
  declare -gA MULTI_PROBE_VERSION=()
  declare -gA MULTI_PLAN_LEVEL=()
  declare -gA MULTI_PLAN_DEGRADED=()
  MULTI_CATALOG_ROOT=$(mktemp -d "${STATE_DIR:?}/.catalog-invoke.XXXXXX")
  # Исполнитель, назначенный ЧЕЛОВЕКОМ, а не политикой профиля: назначение на задачу
  # (`task`) или на этап (`task-stage`). Такой заход предохранитель не отменяет —
  # см. комментарий в lib/dispatcher.sh.
  local human_choice=""
  case "$MULTI_ROUTE_SOURCE" in
    task-stage|task) human_choice=$primary ;;
  esac
  while (( manual_count < 2 )); do
    dispatcher_run_chain "$task" "$stage" "$primary" "$failover" "$(date +%s)" \
      _multi_resolve _multi_invoke "$human_choice"
    rc=$?
    if [[ -n "$MULTI_MANUAL_TARGET" ]]; then
      primary=$MULTI_MANUAL_TARGET
      # Кнопка переключения нажата прямо во время хода — это тот же явный выбор.
      human_choice=$primary
      failover=""
      MULTI_PRIMARY=$primary
      MULTI_FAILOVER=$failover
      MULTI_MANUAL_TARGET=""
      manual_count=$((manual_count + 1))
      switched=1
      continue
    fi
    set_st "$task" "RUNNER_ACTUAL_${stage}" "${DISPATCH_RESULT_RUNNER:-$primary}" \
      "MODEL_ACTUAL_${stage}" "${DISPATCH_RESULT_MODEL:-}" \
      "RUNNER_REASON_${stage}" "$([[ $switched -eq 1 ]] && printf manual_switch || printf '%s' "${DISPATCH_REASON:-primary}")"
    debug_log_event_for "$task" "$stage" decisions dispatch_complete \
      runner "${DISPATCH_RESULT_RUNNER:-$primary}" \
      model "${DISPATCH_RESULT_MODEL:-unknown}" \
      result "${DISPATCH_RESULT_KIND:-unknown}" \
      reason "$([[ $switched -eq 1 ]] && printf manual_switch || printf '%s' "${DISPATCH_REASON:-primary}")" \
      || true
    case "$rc" in
      0)
        _multi_catalog_cleanup
        return 0
        ;;
      2)
        set_st "$task" STALLED_HUMAN 1 "RUNNER_REASON_${stage}" "${DISPATCH_REASON:-unavailable}"
        _multi_catalog_cleanup
        return 79
        ;;
      *)
        _multi_catalog_cleanup
        case "${DISPATCH_RESULT_KIND:-unknown}" in
          denied|invalid_config|context_overflow)
            set_st "$task" STALLED_HUMAN 1 \
              "RUNNER_REASON_${stage}" "$DISPATCH_RESULT_KIND"
            return 79
            ;;
          timeout) return 124 ;;
        esac
        return 1
        ;;
    esac
  done
  set_st "$task" STALLED_HUMAN 1 "RUNNER_REASON_${stage}" manual_switch_conflict
  _multi_catalog_cleanup
  return 79
}
