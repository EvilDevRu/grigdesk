#!/usr/bin/env bash

# Готовность настроенного профиля на этом хосте проверяется только по metadata.
# Пробы читают версию и авторизацию CLI; runner_*_run здесь никогда не вызывается.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/profile-config.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/coverage.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

_profile_preflight_providers() {
  local config=$1 value provider
  while IFS= read -r value; do
    local IFS=,
    for provider in $value; do
      [[ "$provider" =~ ^[a-z][a-z0-9_-]*$ ]] && printf '%s\n' "$provider"
    done
  done < <(
    awk -F= '$1 ~ /(_PRIMARY|_FAILOVER)$/ && $2 != "" {print $2}' "$config"
  )
}

# Пауза между попытками пробы. Отдельной функцией — чтобы тест мог подменить её
# no-op и не платить секундами за проверку самого правила повтора.
_profile_preflight_probe_sleep() {
  sleep "$1"
}

# Проба CLI идемпотентна: она только читает версию и ничего не меняет ни на хосте,
# ни у провайдера, — поэтому право на повтор у неё есть. Повторяется ТОЛЬКО
# транзиент. Детерминированные ответы (`4` — CLI нет вовсе, `2` — контракт раннера
# не выполнен, `126` — офлайн-гвард) ожиданием не лечатся, а лишние попытки задержали
# бы старт. Пауза обязательна: две попытки в одну миллисекунду попадают в одно и то
# же моргание и повтором не являются.
#
# Цена одиночной пробы измерена инцидентом 27.08.2026: снимок покрытия ОБЩИЙ на
# профиль, поэтому моргнувшая проба чужого resume записала `UNAVAILABLE=2` — и
# идущий рядом прогон встал fail-closed на следующем же узле (`coverage_unavailable`).
# Через минуту повторный preflight прошёл без единой правки хоста.
_profile_preflight_probe() {
  local provider=${1:?provider} attempt=0 rc output
  local -a delays=(0.5 1.5)
  while :; do
    # Код пробы снимается СРАЗУ после вызова, а не после `fi`: у `if` без `else`
    # значение конструкции равно нулю при ложном условии, и `rc=$?` там всегда
    # давал бы 0 — то есть недоступный CLI считался бы исправным.
    output=$(runner_call "$provider" probe 2>/dev/null)
    rc=$?
    if [[ "$rc" -eq 0 ]]; then
      [[ "$attempt" -eq 0 ]] ||
        printf 'preflight: проба %s ответила с попытки %s\n' "$provider" "$((attempt + 1))" >&2
      printf '%s\n' "$output"
      return 0
    fi
    case "$rc" in
      2|4|126) return "$rc" ;;
    esac
    [[ "$attempt" -lt "${#delays[@]}" ]] || return "$rc"
    _profile_preflight_probe_sleep "${delays[attempt]}"
    attempt=$((attempt + 1))
  done
}

profile_preflight_ttl() {
  local ttl=${1:-${FACTORY_HOST_PREFLIGHT_TTL:-21600}}
  [[ "$ttl" =~ ^[0-9]+$ && "$ttl" -gt 0 && "$ttl" -le 86400 ]] || return 2
  printf '%s\n' "$ttl"
}

# Единственный профильный писатель снимает статусы всех настроенных провайдеров.
# Строгий результат нужен factory-check; runtime отдельно проверяет свои цепочки.
profile_runner_host_preflight() {
  local profile=$1 now=${2:-$(date +%s)} ttl
  ttl=$(profile_preflight_ttl "${3:-}") || return
  [[ "$profile" =~ ^[A-Za-z0-9._-]+$ &&
     "$now" =~ ^[0-9]+$ && "$ttl" =~ ^[0-9]+$ ]] || return 2
  local profiles_dir=${FACTORY_PROFILES_DIR:-"$(cd "$FACTORY_HOME/.." && pwd)/profiles"}
  local config="$profiles_dir/$profile/runners.env"
  profile_config_validate "$config" || return 78
  runner_registry_reset
  runner_registry_load "${FACTORY_RUNNERS_DIR:-"$FACTORY_HOME/lib/runners"}" || return 78

  local coverage_dir="$STATE_DIR/coverage/$profile"
  mkdir -p "$coverage_dir" || return 78
  local providers plans results provider structural_level host_status provider_key
  local family version variant exact defaults
  local probe_output runner_version
  declare -A preflight_probe_ready=()
  declare -A preflight_structural_ready=()
  declare -A preflight_runtime_versions=()
  providers=$(mktemp "$coverage_dir/.providers.XXXXXX") || return 78
  plans=$(mktemp "$coverage_dir/.plans.XXXXXX") || {
    rm -f -- "$providers"
    return 78
  }
  results=$(mktemp "$coverage_dir/.host-results.XXXXXX") || {
    rm -f -- "$providers" "$plans"
    return 78
  }
  _profile_preflight_providers "$config" | LC_ALL=C sort -u >"$providers" || {
    rm -f -- "$providers" "$plans" "$results"
    return 78
  }

  while IFS= read -r provider; do
    [[ -n "$provider" ]] || continue
    provider_key=$(_multi_provider_key "$provider")
    family=$(profile_config_get "$config" "MODEL_DEFAULT_${provider_key}_FAMILY")
    version=$(profile_config_get "$config" "MODEL_DEFAULT_${provider_key}_VERSION")
    variant=$(profile_config_get "$config" "MODEL_DEFAULT_${provider_key}_VARIANT")
    exact=$(profile_config_get "$config" "MODEL_DEFAULT_${provider_key}_EXACT")
    if [[ -z "$family" && -z "$exact" ]] &&
       declare -F "runner_${provider}_default_policy" >/dev/null; then
      defaults=$("runner_${provider}_default_policy" DEFAULT)
      family=$(awk -F= '$1=="FAMILY"{print $2}' <<<"$defaults")
      version=$(awk -F= '$1=="VERSION"{print $2}' <<<"$defaults")
      variant=$(awk -F= '$1=="VARIANT"{print $2}' <<<"$defaults")
    fi
    [[ -n "$version" ]] || version=latest
    [[ -n "$variant" ]] || variant=auto
    if probe_output=$(_profile_preflight_probe "$provider"); then
      preflight_probe_ready["$provider"]=1
    else
      probe_output=""
      preflight_probe_ready["$provider"]=0
    fi
    # Не отбрасываем prerelease: pinned runner `0.1.5-rc.2` должен сравниваться
    # с catalog min/max как exact версия, а не как более старая `0.1.5`.
    runner_version=$(_multi_probe_version "$probe_output")
    if declare -F "runner_${provider}_refresh_probe" >/dev/null &&
       runner_call "$provider" refresh_probe; then
      preflight_runtime_versions["$provider"]=$runner_version
      printf 'runtime\t%s\t%s\n' "$provider" "$runner_version" >>"$results"
    fi
    MULTI_CATALOG_ROOT=$(mktemp -d "${STATE_DIR:?}/.catalog-invoke.XXXXXX") || {
      rm -f -- "$providers" "$plans" "$results"
      return 78
    }
    if runner_registry_has "$provider" && runner_contract_check "$provider" &&
       _multi_catalog_model "$provider" "$family" "$version" "$variant" "$exact" "$runner_version"; then
      structural_level=native
      preflight_structural_ready["$provider"]=1
    else
      structural_level=unavailable
      preflight_structural_ready["$provider"]=0
    fi
    _multi_catalog_cleanup
    printf '%s\tRUNNER\t%s\t%s\n' "$profile" "$provider" "$structural_level" >>"$plans"
  done <"$providers"

  local revision structural_hash structural="$coverage_dir/structural.env"
  revision=$(sha256sum "$config" | awk '{print substr($1,1,16)}')
  structural_hash=$(coverage_structural_hash "$config" "$plans")
  coverage_structural_write "$structural" "$structural_hash" "$revision" "$plans" || {
    rm -f -- "$providers" "$plans" "$results"
    return 78
  }

  local unavailable=0 total=0 unavailable_runners=""
  while IFS= read -r provider; do
    [[ -n "$provider" ]] || continue
    total=$((total + 1))
    if runner_registry_has "$provider" && runner_contract_check "$provider" &&
       [[ "${preflight_probe_ready[$provider]:-0}" == 1 ]]; then
      host_status=ready
    else
      host_status=unavailable
      unavailable=$((unavailable + 1))
    fi
    if [[ "$host_status" == unavailable ||
          "${preflight_structural_ready[$provider]:-0}" != 1 ]]; then
      if [[ -n "$unavailable_runners" ]]; then
        unavailable_runners+=",$provider"
      else
        unavailable_runners=$provider
      fi
    fi
    printf 'runner\t%s\t%s\n' "$provider" "$host_status" >>"$results"
  done <"$providers"

  local host_hash host="$coverage_dir/host.env" tmp
  host_hash=$(
    {
      printf 'structural:%s\ncatalog:%s\n' "$structural_hash" "$revision"
      LC_ALL=C sort "$results"
    } | sha256sum | awk '{print $1}'
  ) || {
    rm -f -- "$providers" "$plans" "$results"
    return 78
  }
  tmp=$(mktemp "$coverage_dir/.host.XXXXXX") || {
    rm -f -- "$providers" "$plans" "$results"
    return 78
  }
  {
    printf 'SCHEMA=2\nKIND=host\nHASH=%s\nSTRUCTURAL_HASH=%s\n' \
      "$host_hash" "$structural_hash"
    printf 'CATALOG_REVISION=%s\nTOTAL=%s\nUNAVAILABLE=%s\nUNAVAILABLE_RUNNERS=%s\n' \
      "$revision" "$total" "$unavailable" "$unavailable_runners"
    printf 'FETCHED_AT=%s\nEXPIRES_AT=%s\n' "$now" "$((now + ttl))"
    printf 'PROVIDERS=%s\n' "$(paste -sd, "$providers")"
    awk -F '\t' '$1 == "runner" { print "PROVIDER_" $2 "=" $3 }' "$results"
    while IFS= read -r provider; do
      [[ -z "${preflight_runtime_versions[$provider]:-}" ]] ||
        printf 'RUNTIME_VERSION_%s=%s\n' "$provider" "${preflight_runtime_versions[$provider]}"
    done <"$providers"
  } >"$tmp" || {
    rm -f -- "$tmp" "$providers" "$plans" "$results"
    return 78
  }
  mv -f -- "$tmp" "$host" || {
    rm -f -- "$tmp" "$providers" "$plans" "$results"
    return 78
  }
  rm -f -- "$providers" "$plans" "$results"

  [[ "$(coverage_artifact_get "$structural" UNAVAILABLE)" == 0 && "$unavailable" == 0 ]]
}
