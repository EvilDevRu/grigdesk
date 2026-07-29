#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/breaker.sh"
source "$FACTORY_HOME/lib/runners/policy.sh"

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
  local provider family model family_fallback fingerprint result started requested_family
  local last_switch_reason="" scope skip_provider
  DISPATCH_RESULT_KIND=""
  DISPATCH_RESULT_RUNNER=""
  DISPATCH_RESULT_FAMILY=""
  DISPATCH_RESULT_MODEL=""
  DISPATCH_REASON=primary
  DISPATCH_TRIES_DELTA=0
  DISPATCH_STALLED_HUMAN=0
  while IFS= read -r provider; do
    [[ "$provider" =~ ^[a-z][a-z0-9_-]*$ ]] || continue
    requested_family=""
    skip_provider=0
    while (( skip_provider == 0 )); do
      DISPATCH_RESOLVE_RESULT=route_unavailable
      "$resolve_fn" "$provider" "$requested_family" || {
        result=${DISPATCH_RESOLVE_RESULT:-route_unavailable}
        runner_result_class_valid "$result" || result=unknown
        if runner_transition_allowed preflight "$result" auto 0; then
          last_switch_reason=$result
          skip_provider=1
          break
        fi
        DISPATCH_RESULT_KIND=$result
        DISPATCH_RESULT_RUNNER=""
        DISPATCH_REASON=$result
        return 1
      }
      family=$DISPATCH_RESOLVED_FAMILY
      model=$DISPATCH_RESOLVED_MODEL
      family_fallback=${DISPATCH_FAMILY_FAILOVER:-}
      fingerprint=$DISPATCH_CREDENTIAL_FINGERPRINT
      if breaker_match "$provider" "$fingerprint" "$family" "$model" "$now"; then
        scope=$BREAKER_MATCH_SCOPE
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
      DISPATCH_INVOKE_STARTED=1
      DISPATCH_LIMIT_SCOPE=provider
      DISPATCH_LIMIT_UNTIL=""
      "$invoke_fn" "$provider" "$family" "$model"
      result=$DISPATCH_INVOKE_RESULT
      started=$DISPATCH_INVOKE_STARTED
      runner_result_class_valid "$result" || result=unknown
      DISPATCH_RESULT_RUNNER=$provider
      DISPATCH_RESULT_FAMILY=$family
      DISPATCH_RESULT_MODEL=$model
      DISPATCH_RESULT_KIND=$result

      if [[ "$result" == ok ]]; then
        [[ -n "$last_switch_reason" ]] && DISPATCH_REASON=$last_switch_reason
        return 0
      fi
      if [[ "$started" == 0 ]]; then
        if runner_transition_allowed preflight "$result" auto 0; then
          last_switch_reason=unavailable
          skip_provider=1
          break
        fi
        DISPATCH_REASON=$result
        return 1
      fi
      # 401/403 разрешают переход только как отдельный строгий класс:
      # classifier обязан доказать, что текущая попытка не получила ни одного
      # реального ответа модели и не запустила инструмент. Никакого breaker здесь
      # нет: после повторного входа provider должен ожить сразу.
      if [[ "$result" == provider_unavailable ]] &&
         runner_transition_allowed started "$result" auto 0; then
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
          if [[ "$scope" != provider && -n "$family_fallback" && \
                "$family" != "$family_fallback" ]]; then
            requested_family=$family_fallback
            continue
          fi
          skip_provider=1
          break
      fi
      DISPATCH_REASON=$result
      return 1
    done
  done < <(_dispatcher_chain "$primary" "$failover")
  DISPATCH_RESULT_KIND=stalled
  DISPATCH_REASON=${last_switch_reason:-unavailable}
  DISPATCH_STALLED_HUMAN=1
  return 2
}
