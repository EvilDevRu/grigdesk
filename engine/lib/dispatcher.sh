#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/breaker.sh"
source "$FACTORY_HOME/lib/runners/policy.sh"
source "$FACTORY_HOME/lib/runtime-analytics.sh"

_dispatcher_chain() {
  local primary=$1 failover=$2 item seen=","
  printf '%s\n' "$primary"
  local IFS=,
  for item in $failover; do
    [[ -n "$item" && "$seen" != *",$item,"* && "$item" != "$primary" ]] || continue
    printf '%s\n' "$item"
    seen+="$item,"
  done
}

dispatcher_run_chain() {
  local task=$1 stage=$2 primary=$3 failover=$4 now=$5 resolve_fn=$6 invoke_fn=$7
  # Восьмой аргумент — исполнитель, НАЗВАННЫЙ ЧЕЛОВЕКОМ (назначение на задачу/этап
  # либо нажатая кнопка переключения). Пусто = маршрут выбран политикой профиля.
  local human_choice=${8:-}
  local provider family model family_fallback fingerprint result started requested_family
  local last_switch_reason="" scope skip_provider candidate_ordinal=-1 candidate_count
  local policy_source policy_hash dispatch_ordinal lifecycle_reason breaker_result
  local skip_reason preflight_result selected_run selected_epoch
  local pending_from_run="" pending_from_epoch="" pending_from_provider=""
  local pending_reason="" pending_scope=none
  DISPATCH_RESULT_KIND=""
  DISPATCH_RESULT_DETAIL=""
  DISPATCH_RESULT_RUNNER=""
  DISPATCH_RESULT_FAMILY=""
  DISPATCH_RESULT_MODEL=""
  DISPATCH_REASON=primary
  DISPATCH_TRIES_DELTA=0
  DISPATCH_STALLED_HUMAN=0
  policy_source=${MULTI_DISPATCH_SOURCE_OVERRIDE:-${MULTI_ROUTE_SOURCE:-profile-project}}
  candidate_count=$(_dispatcher_chain "$primary" "$failover" | awk 'NF {count++} END {print count+0}')
  (( candidate_count > 0 )) || return 78
  policy_hash=$(runtime_analytics_hash_string_v2 \
    "$task|$stage|$primary|$failover|$policy_source") || return
  dispatch_ordinal=${MULTI_DISPATCH_ORDINAL:-0}
  runtime_lifecycle_dispatch_begin_v2 \
    "$policy_source" "$policy_hash" "$candidate_count" "$dispatch_ordinal" \
    >/dev/null || return
  while IFS= read -r provider; do
    [[ "$provider" =~ ^[a-z][a-z0-9_-]*$ ]] || continue
    candidate_ordinal=$((candidate_ordinal + 1))
    requested_family=""
    skip_provider=0
    while (( skip_provider == 0 )); do
      DISPATCH_RESOLVE_RESULT=route_unavailable
      "$resolve_fn" "$provider" "$requested_family" || {
        result=${DISPATCH_RESOLVE_RESULT:-route_unavailable}
        runner_result_class_valid "$result" || result=unknown
        skip_reason=provider_unavailable
        preflight_result=unknown
        case "$result" in
          unavailable_preflight) skip_reason=preflight_unavailable; preflight_result=unavailable ;;
          invalid_config) skip_reason=model_unavailable ;;
          route_unavailable) skip_reason=model_unavailable ;;
        esac
        runtime_lifecycle_dispatch_candidate_skipped_v2 \
          "$candidate_ordinal" "$provider" unknown '' '' "$requested_family" \
          "$policy_source" not_applicable "$preflight_result" "$skip_reason" '' \
          >/dev/null || return
        if runner_transition_allowed preflight "$result" auto 0; then
          last_switch_reason=$result
          skip_provider=1
          break
        fi
        DISPATCH_RESULT_KIND=$result
        DISPATCH_RESULT_RUNNER=""
        DISPATCH_REASON=$result
        runtime_lifecycle_dispatch_finish_v2 failed unavailable exhausted '' '' \
          >/dev/null || return
        return 1
      }
      family=$DISPATCH_RESOLVED_FAMILY
      model=$DISPATCH_RESOLVED_MODEL
      family_fallback=${DISPATCH_FAMILY_FAILOVER:-}
      fingerprint=$DISPATCH_CREDENTIAL_FINGERPRINT
      # Предохранитель — ДОГАДКА по прошлому отказу: он лишь предполагает, что
      # провайдер всё ещё в лимите. Нажатая человеком кнопка — факт, и он сильнее:
      # молчаливая подмена выглядела как сломанная кнопка («не могу переключить на
      # клода»), а человек терял время, не понимая, почему этап уехал в резерв.
      # Обход ИМЕННОЙ: холостой заход разрешён ровно одному названному исполнителю,
      # резерв за ним остаётся под предохранителем и цепочка не дорожает целиком.
      if [[ "$provider" != "$human_choice" ]] &&
         breaker_match "$provider" "$fingerprint" "$family" "$model" "$now"; then
        scope=$BREAKER_MATCH_SCOPE
        runtime_lifecycle_dispatch_candidate_skipped_v2 \
          "$candidate_ordinal" "$provider" "$model" "$model" \
          "${DISPATCH_RESOLVED_EFFORT:-}" "$family" "$policy_source" open available \
          breaker_open '' >/dev/null || return
        if [[ "$scope" != provider && -n "$family_fallback" && \
              "$family" != "$family_fallback" ]]; then
          requested_family=$family_fallback
          last_switch_reason=fallback_limit
          continue
        else
          last_switch_reason=fallback_limit
          skip_provider=1
          break
        fi
      fi

      DISPATCH_INVOKE_RESULT=unknown
      DISPATCH_INVOKE_DETAIL=""
      DISPATCH_INVOKE_STARTED=1
      DISPATCH_LIMIT_SCOPE=provider
      DISPATCH_LIMIT_UNTIL=""
      lifecycle_reason=primary
      if [[ "$policy_source" == manual-switch ]]; then
        lifecycle_reason=manual_switch
      elif [[ -n "$requested_family" ]]; then
        lifecycle_reason=model_fallback
      elif [[ -n "$last_switch_reason" ]]; then
        lifecycle_reason=provider_failover
      fi
      if [[ -n "$pending_from_run" ]]; then
        runtime_lifecycle_failover_selected_v2 \
          "$pending_from_run" "$pending_from_epoch" "$pending_from_provider" \
          "$provider" "$pending_reason" "$pending_scope" '' >/dev/null || return
        pending_from_run=""
      fi
      breaker_result=closed
      [[ "$provider" != "$human_choice" ]] || breaker_result=not_applicable
      runtime_lifecycle_dispatch_candidate_selected_v2 \
        "$candidate_ordinal" "$provider" "$model" "$model" \
        "${DISPATCH_RESOLVED_EFFORT:-}" "$family" "$policy_source" \
        "$breaker_result" available "$lifecycle_reason" >/dev/null || return
      export FACTORY_LIFECYCLE_CANDIDATE_ORDINAL=$candidate_ordinal
      export FACTORY_LIFECYCLE_RUN_REASON=$lifecycle_reason
      "$invoke_fn" "$provider" "$family" "$model"
      result=$DISPATCH_INVOKE_RESULT
      started=$DISPATCH_INVOKE_STARTED
      runner_result_class_valid "$result" || result=unknown
      DISPATCH_RESULT_RUNNER=$provider
      DISPATCH_RESULT_FAMILY=$family
      DISPATCH_RESULT_MODEL=$model
      DISPATCH_RESULT_KIND=$result
      DISPATCH_RESULT_DETAIL=${DISPATCH_INVOKE_DETAIL:-}

      if [[ "$result" == manual_switch && -n "${MULTI_MANUAL_TARGET:-}" ]]; then
        runtime_lifecycle_dispatch_finish_v2 interrupted manual_switch interrupted \
          "$candidate_ordinal" "${MULTI_LAST_RUN_ID:-}" >/dev/null || return
        DISPATCH_REASON=manual_switch
        return 1
      fi
      if [[ "$result" == ok ]]; then
        [[ -n "$last_switch_reason" ]] && DISPATCH_REASON=$last_switch_reason
        selected_run=${MULTI_LAST_RUN_ID:-}
        runtime_lifecycle_dispatch_finish_v2 succeeded normal selected \
          "$candidate_ordinal" "$selected_run" >/dev/null || return
        return 0
      fi
      if [[ "$started" == 0 ]]; then
        runtime_lifecycle_dispatch_candidate_skipped_v2 \
          "$candidate_ordinal" "$provider" "$model" "$model" \
          "${DISPATCH_RESOLVED_EFFORT:-}" "$family" "$policy_source" \
          not_applicable unavailable preflight_unavailable '' >/dev/null || return
        if runner_transition_allowed preflight "$result" auto 0; then
          last_switch_reason=unavailable
          skip_provider=1
          break
        fi
        DISPATCH_REASON=$result
        runtime_lifecycle_dispatch_finish_v2 failed unavailable exhausted '' '' \
          >/dev/null || return
        return 1
      fi
      # 401/403 разрешают переход только как отдельный строгий класс:
      # classifier обязан доказать, что текущая попытка не получила ни одного
      # реального ответа модели и не запустила инструмент. Никакого breaker здесь
      # нет: после повторного входа provider должен ожить сразу.
      if [[ "$result" == provider_unavailable ]] &&
         runner_transition_allowed started "$result" auto 0; then
        pending_from_run=${MULTI_LAST_RUN_ID:-}
        pending_from_epoch=${MULTI_LAST_RUN_EPOCH:-}
        pending_from_provider=$provider
        pending_reason=provider_unavailable
        pending_scope=provider
        last_switch_reason=fallback_provider_unavailable
        skip_provider=1
        break
      fi
      if runner_transition_allowed started "$result" auto 0 && [[ "$result" == limited ]]; then
          scope=${DISPATCH_LIMIT_SCOPE:-provider}
          case "$scope" in
            provider)
              breaker_record "$provider" "$fingerprint" provider "" "" "$now" \
                "${DISPATCH_LIMIT_UNTIL:-}" classifier ;;
            family)
              breaker_record "$provider" "$fingerprint" family "$family" "" "$now" \
                "${DISPATCH_LIMIT_UNTIL:-}" classifier ;;
            model)
              breaker_record "$provider" "$fingerprint" model "$family" "$model" "$now" \
                "${DISPATCH_LIMIT_UNTIL:-}" classifier ;;
            *) return 1 ;;
          esac
          last_switch_reason=fallback_limit
          pending_from_run=${MULTI_LAST_RUN_ID:-}
          pending_from_epoch=${MULTI_LAST_RUN_EPOCH:-}
          pending_from_provider=$provider
          pending_reason=limited
          pending_scope=$scope
          if [[ "$scope" != provider && -n "$family_fallback" && \
                "$family" != "$family_fallback" ]]; then
            requested_family=$family_fallback
            continue
          fi
          skip_provider=1
          break
      fi
      DISPATCH_REASON=$result
      runtime_lifecycle_dispatch_finish_v2 failed unavailable exhausted '' '' \
        >/dev/null || return
      return 1
    done
  done < <(_dispatcher_chain "$primary" "$failover")
  DISPATCH_RESULT_KIND=stalled
  DISPATCH_REASON=${last_switch_reason:-unavailable}
  DISPATCH_STALLED_HUMAN=1
  runtime_lifecycle_dispatch_finish_v2 failed exhausted exhausted '' '' \
    >/dev/null || return
  return 2
}
