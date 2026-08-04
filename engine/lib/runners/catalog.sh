#!/usr/bin/env bash

_catalog_meta_get() {
  local file=${1:?meta file} key=${2:?key}
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

_catalog_checksum() {
  local dir=${1:?snapshot dir}
  { cat "$dir/meta.env"; cat "$dir/models.tsv"; } | sha256sum | awk '{print $1}'
}

catalog_snapshot_verify() {
  local dir=${1:?snapshot dir} now=${2:?now} runner_version=${3:?runner version}
  local auth_fingerprint=${4:?auth fingerprint}
  [[ -f "$dir/meta.env" && -f "$dir/models.tsv" && -f "$dir/READY" ]] || return 1
  local expected actual schema source expires snapshot_runner snapshot_auth
  expected=$(head -1 "$dir/READY" 2>/dev/null | tr -d '[:space:]')
  actual=$(_catalog_checksum "$dir") || return 1
  [[ -n "$expected" && "$expected" == "$actual" ]] || return 1
  schema=$(_catalog_meta_get "$dir/meta.env" SCHEMA)
  source=$(_catalog_meta_get "$dir/meta.env" SOURCE)
  expires=$(_catalog_meta_get "$dir/meta.env" EXPIRES_AT)
  snapshot_runner=$(_catalog_meta_get "$dir/meta.env" RUNNER_VERSION)
  snapshot_auth=$(_catalog_meta_get "$dir/meta.env" AUTH_FINGERPRINT)
  [[ "$schema" == 1 ]] || return 1
  [[ "$source" == live || "$source" == cache || "$source" == seed-probed ]] || return 1
  [[ "$snapshot_runner" == "$runner_version" && "$snapshot_auth" == "$auth_fingerprint" ]] || return 1
  if [[ "$source" != seed-probed ]]; then
    [[ "$expires" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ && "$now" -le "$expires" ]] || return 1
  fi
  return 0
}

catalog_snapshot_select() {
  local live_dir=${1:?live dir} cache_dir=${2:?cache dir} seed_dir=${3:?seed dir}
  local now=${4:?now} runner_version=${5:?runner version} auth_fingerprint=${6:?auth fingerprint}
  local dir expected_source source
  for dir in "$live_dir" "$cache_dir" "$seed_dir"; do
    case "$dir" in
      "$live_dir") expected_source=live ;;
      "$cache_dir") expected_source=cache ;;
      *) expected_source=seed-probed ;;
    esac
    catalog_snapshot_verify "$dir" "$now" "$runner_version" "$auth_fingerprint" || continue
    source=$(_catalog_meta_get "$dir/meta.env" SOURCE)
    [[ "$source" == "$expected_source" ]] || continue
    printf '%s\n' "$dir"
    return 0
  done
  printf 'no_candidate\n'
  return 4
}

_catalog_version_le() {
  local left=$1 right=$2 first
  first=$(printf '%s\n%s\n' "$left" "$right" | sort -V | head -1)
  [[ "$first" == "$left" ]]
}

_catalog_runner_compatible() {
  local actual=$1 minimum=$2 maximum=$3
  # `*` — явная совместимость по контракту, а не по semver. Она нужна раннерам,
  # у которых новый CLI допускается тем же fail-closed парсером: фактическая
  # версия всё равно попадает в meta.env, но сама по себе не гасит provider.
  [[ "$minimum" == '*' ]] || _catalog_version_le "$minimum" "$actual" || return 1
  [[ "$maximum" == '*' ]] || _catalog_version_le "$actual" "$maximum"
}

catalog_resolve() {
  local dir=${1:?snapshot dir} provider=${2:?provider} family=${3:?family}
  local requested_version=${4:?version} requested_variant=${5:?variant}
  local runner_version=${6:?runner version}
  local id p f version variant release stable deprecated available minimum maximum
  local best_id="" best_release=-1 best_version=""
  while IFS=$'\t' read -r id p f version variant release stable deprecated available minimum maximum; do
    [[ "$p" == "$provider" && "$f" == "$family" ]] || continue
    [[ "$stable" == 1 && "$deprecated" == 0 && "$available" == 1 ]] || continue
    _catalog_runner_compatible "$runner_version" "$minimum" "$maximum" || continue
    if [[ "$requested_version" != latest && "$version" != "$requested_version" ]]; then
      continue
    fi
    if [[ "$requested_variant" == auto ]]; then
      [[ "$variant" == default ]] || continue
    elif [[ "$variant" != "$requested_variant" ]]; then
      continue
    fi
    [[ "$release" =~ ^[0-9]+$ ]] || continue
    if (( release > best_release )) || \
       { (( release == best_release )) && [[ "$version:$id" > "$best_version:$best_id" ]]; }; then
      best_id=$id
      best_release=$release
      best_version=$version
    fi
  done <"$dir/models.tsv"
  if [[ -z "$best_id" ]]; then
    printf 'no_candidate\n'
    return 4
  fi
  printf '%s\n' "$best_id"
}

catalog_resolve_exact() {
  local dir=${1:?snapshot dir} provider=${2:?provider} requested_id=${3:?model id}
  local runner_version=${4:?runner version}
  local id p family version variant release stable deprecated available minimum maximum
  while IFS=$'\t' read -r id p family version variant release stable deprecated available minimum maximum; do
    [[ "$p" == "$provider" && "$id" == "$requested_id" ]] || continue
    # Exact pin — осознанная фиксация. Deprecated/beta не подменяем автоматически:
    # пока id доступен текущему auth и CLI, воспроизводимость важнее latest-policy.
    [[ "$available" == 1 ]] || break
    _catalog_runner_compatible "$runner_version" "$minimum" "$maximum" || break
    printf '%s\n' "$id"
    return 0
  done <"$dir/models.tsv"
  printf 'no_candidate\n'
  return 4
}
