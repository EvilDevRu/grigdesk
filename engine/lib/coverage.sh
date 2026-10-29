#!/usr/bin/env bash

coverage_artifact_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

coverage_structural_hash() {
  local index=0 file line
  {
    for file in "$@"; do
      index=$((index + 1))
      while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%d:%d:%s\n' "$index" "${#line}" "$line"
      done < <(LC_ALL=C sort "$file")
    done
  } | sha256sum | awk '{print $1}'
}

# Структурные планы сводятся в именные уровни покрытия провайдеров.
# Снимок публикуется атомарно и связан с revision конфигурации через общий hash.
coverage_structural_write() {
  local artifact=$1 hash=$2 catalog_revision=$3 plans=$4
  local total unavailable native adapted degraded tmp
  total=$(grep -c . "$plans" 2>/dev/null || true)
  unavailable=$(awk -F "$(_coverage_tab)" '$4=="unavailable"{n++} END{print n+0}' "$plans")
  native=$(awk -F "$(_coverage_tab)" '$4=="native"{n++} END{print n+0}' "$plans")
  adapted=$(awk -F "$(_coverage_tab)" '$4=="adapted"{n++} END{print n+0}' "$plans")
  degraded=$(awk -F "$(_coverage_tab)" '$4=="degraded"{n++} END{print n+0}' "$plans")
  mkdir -p "$(dirname "$artifact")"
  tmp=$(mktemp "$(dirname "$artifact")/.coverage.XXXXXX")
  {
    printf 'SCHEMA=2\nKIND=structural\nHASH=%s\nCATALOG_REVISION=%s\n' \
      "$hash" "$catalog_revision"
    printf 'TOTAL=%s\nNATIVE=%s\nADAPTED=%s\nDEGRADED=%s\nUNAVAILABLE=%s\n' \
      "$total" "$native" "$adapted" "$degraded" "$unavailable"
    # Несколько планов одного провайдера сводятся к худшему уровню покрытия.
    # Счётчики остаются диагностикой; runtime читает только именные статусы.
    awk -F '\t' '
      BEGIN {
        rank["native"]=1
        rank["adapted"]=2
        rank["degraded"]=3
        rank["unavailable"]=4
      }
      rank[$4] > rank[level[$3]] { level[$3]=$4 }
      END {
        for (provider in level) {
          print provider "=" level[provider]
        }
      }
    ' "$plans" | LC_ALL=C sort | awk -F= '
      {
        providers=providers (NR > 1 ? "," : "") $1
        statuses=statuses "PROVIDER_" $0 "\n"
      }
      END {
        print "PROVIDERS=" providers
        printf "%s", statuses
      }
    '
  } >"$tmp"
  mv -f -- "$tmp" "$artifact"
}

_coverage_tab() {
  printf '\t'
}

_coverage_host_check() {
  local kind=$1 path=$2
  case "$kind" in
    executable) [[ -x "$path" && -f "$path" ]] ;;
    readable) [[ -r "$path" ]] ;;
    writable) [[ -d "$path" && -w "$path" ]] ;;
    *) return 1 ;;
  esac
}

# Проверяет файловые требования metadata-манифеста без запуска модели.
# Повторяющиеся имена сводятся к худшему статусу, как планы структурного слоя.
coverage_host_preflight() {
  local manifest=$1 structural_hash=$2 catalog_revision=$3 now=$4 ttl=$5 artifact=$6
  [[ "$now" =~ ^[0-9]+$ && "$ttl" =~ ^[0-9]+$ ]] || return 2
  local results kind name path status unavailable=0 total=0 host_hash tmp
  results=$(mktemp "${TMPDIR:-/tmp}/factory-host-results.XXXXXX")
  while IFS=$'\t' read -r kind name path; do
    [[ -n "$kind" ]] || continue
    total=$((total + 1))
    if _coverage_host_check "$kind" "$path"; then
      status=ready
    else
      status=unavailable
      unavailable=$((unavailable + 1))
    fi
    printf '%s\t%s\t%s\t%s\n' "$kind" "$name" "$path" "$status" >>"$results"
  done <"$manifest"
  host_hash=$(
    {
      printf 'structural:%s\ncatalog:%s\n' "$structural_hash" "$catalog_revision"
      LC_ALL=C sort "$results"
    } | sha256sum | awk '{print $1}'
  )
  mkdir -p "$(dirname "$artifact")"
  tmp=$(mktemp "$(dirname "$artifact")/.host-coverage.XXXXXX")
  {
    printf 'SCHEMA=2\nKIND=host\nHASH=%s\nSTRUCTURAL_HASH=%s\n' \
      "$host_hash" "$structural_hash"
    printf 'CATALOG_REVISION=%s\nTOTAL=%s\nUNAVAILABLE=%s\nFETCHED_AT=%s\nEXPIRES_AT=%s\n' \
      "$catalog_revision" "$total" "$unavailable" "$now" "$((now + ttl))"
    awk -F '\t' '
      {
        if (!($2 in status) || $4 == "unavailable") {
          status[$2]=$4
        }
      }
      END {
        for (provider in status) {
          print provider "=" status[provider]
        }
      }
    ' "$results" | LC_ALL=C sort | awk -F= '
      {
        providers=providers (NR > 1 ? "," : "") $1
        statuses=statuses "PROVIDER_" $0 "\n"
      }
      END {
        print "PROVIDERS=" providers
        printf "%s", statuses
      }
    '
  } >"$tmp"
  mv -f -- "$tmp" "$artifact"
  rm -f -- "$results"
  (( unavailable == 0 ))
}

# Именная готовность объединяет структурный уровень и доступность CLI на хосте.
# Отсутствующий провайдер никогда не получает разрешение на модельный вызов.
coverage_provider_ready() {
  local structural=$1 host=$2 provider=$3 level readiness
  [[ ",$(coverage_artifact_get "$structural" PROVIDERS)," == *",$provider,"* &&
     ",$(coverage_artifact_get "$host" PROVIDERS)," == *",$provider,"* ]] || return 1
  level=$(coverage_artifact_get "$structural" "PROVIDER_$provider")
  readiness=$(coverage_artifact_get "$host" "PROVIDER_$provider")
  [[ "$level" =~ ^(native|adapted|degraded)$ && "$readiness" == ready ]]
}

# Без пятого аргумента каталог требует готовности всех провайдеров снимка.
# С цепочкой достаточно одного готового кандидата; чужая недоступность не влияет.
# Код отказа общий, причина отделяет недоступность от порчи и истечения снимка.
coverage_gate() {
  local structural=$1 host=$2 expected_revision=$3 now=$4
  COVERAGE_GATE_REASON=invalid
  COVERAGE_UNAVAILABLE_RUNNERS=''
  [[ "$now" =~ ^[0-9]+$ ]] || return 77
  if [[ "$(coverage_artifact_get "$structural" SCHEMA)" == 1 ||
        "$(coverage_artifact_get "$host" SCHEMA)" == 1 ]]; then
    COVERAGE_GATE_REASON=obsolete_schema
    return 77
  fi
  [[ "$(coverage_artifact_get "$structural" SCHEMA)" == 2 &&
     "$(coverage_artifact_get "$structural" KIND)" == structural &&
     "$(coverage_artifact_get "$host" SCHEMA)" == 2 &&
     "$(coverage_artifact_get "$host" KIND)" == host ]] || return 77
  local structural_hash structural_revision host_structural host_revision expires
  structural_hash=$(coverage_artifact_get "$structural" HASH)
  structural_revision=$(coverage_artifact_get "$structural" CATALOG_REVISION)
  host_structural=$(coverage_artifact_get "$host" STRUCTURAL_HASH)
  host_revision=$(coverage_artifact_get "$host" CATALOG_REVISION)
  expires=$(coverage_artifact_get "$host" EXPIRES_AT)
  [[ -n "$structural_hash" && "$structural_revision" == "$expected_revision" &&
     "$host_revision" == "$expected_revision" &&
     "$host_structural" == "$structural_hash" ]] || return 77
  local providers chain provider ready=0 strict=0
  providers=$(coverage_artifact_get "$structural" PROVIDERS)
  [[ "$providers" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ &&
     "$(coverage_artifact_get "$host" PROVIDERS)" == "$providers" ]] || return 77
  chain=${5-$providers}
  (( $# >= 5 )) || strict=1
  [[ -z "$chain" || "$chain" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ ]] || return 77
  local IFS=,
  for provider in $chain; do
    if [[ ",$providers," == *",$provider,"* ]]; then
      [[ "$(coverage_artifact_get "$structural" "PROVIDER_$provider")" =~ \
          ^(native|adapted|degraded|unavailable)$ &&
         "$(coverage_artifact_get "$host" "PROVIDER_$provider")" =~ ^(ready|unavailable)$ ]] || return 77
    fi
    if coverage_provider_ready "$structural" "$host" "$provider"; then
      ready=1
    else
      COVERAGE_UNAVAILABLE_RUNNERS+="${COVERAGE_UNAVAILABLE_RUNNERS:+,}$provider"
    fi
  done
  if [[ -n "$chain" ]] && { (( ready == 0 )) ||
      { (( strict == 1 )) && [[ -n "$COVERAGE_UNAVAILABLE_RUNNERS" ]]; }; }; then
    COVERAGE_GATE_REASON=unavailable
    return 77
  fi
  [[ "$expires" =~ ^(0|[1-9][0-9]*)$ ]] || return 77
  if [[ "$now" -le "$expires" ]]; then
    COVERAGE_GATE_REASON=ready
    return 0
  fi
  if [[ "$now" -gt "$expires" ]]; then
    COVERAGE_GATE_REASON=expired
  fi
  return 77
}

coverage_catalog_promote() {
  local catalog_state=$1 candidate_revision=$2 structural=$3 host=$4 now=$5
  coverage_gate "$structural" "$host" "$candidate_revision" "$now" || return 77
  mkdir -p "$catalog_state"
  local tmp
  tmp=$(mktemp "$catalog_state/.active.XXXXXX")
  printf '%s\n' "$candidate_revision" >"$tmp"
  mv -f -- "$tmp" "$catalog_state/active"
}
