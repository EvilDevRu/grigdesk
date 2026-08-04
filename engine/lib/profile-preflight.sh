#!/usr/bin/env bash

# Host-dependent readiness for an already configured profile. Probe methods may
# inspect CLI version/auth metadata, but this module never calls runner_*_run.

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

profile_preflight_ttl() {
  local ttl=${1:-${FACTORY_HOST_PREFLIGHT_TTL:-21600}}
  [[ "$ttl" =~ ^[0-9]+$ && "$ttl" -gt 0 && "$ttl" -le 86400 ]] || return 2
  printf '%s\n' "$ttl"
}

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
    if probe_output=$(runner_call "$provider" probe 2>/dev/null); then
      preflight_probe_ready["$provider"]=1
    else
      probe_output=""
      preflight_probe_ready["$provider"]=0
    fi
    runner_version=$(grep -oE '[0-9]+([.][0-9]+)+' <<<"$probe_output" | head -1)
    [[ -n "$runner_version" ]] || runner_version=1.0.0
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
    printf 'SCHEMA=1\nKIND=host\nHASH=%s\nSTRUCTURAL_HASH=%s\n' \
      "$host_hash" "$structural_hash"
    printf 'CATALOG_REVISION=%s\nTOTAL=%s\nUNAVAILABLE=%s\nUNAVAILABLE_RUNNERS=%s\n' \
      "$revision" "$total" "$unavailable" "$unavailable_runners"
    printf 'FETCHED_AT=%s\nEXPIRES_AT=%s\n' "$now" "$((now + ttl))"
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
