#!/usr/bin/env bash
# Host-controlled транзакция временной инструментации.
#
# Транзакция работает только с заранее объявленным списком файлов. Она:
# 1) сохраняет точный baseline и исходное содержимое scope;
# 2) на checkpoint доказывает отсутствие изменений вне scope;
# 3) перед cleanup сверяет весь workspace с последним expected snapshot;
# 4) восстанавливает только transaction-owned scope;
# 5) при несовпадении останавливается и ничего не перезаписывает.
#
# Scope-файлы нельзя отличить от параллельной человеческой правки постфактум. Поэтому
# begin разрешён либо в выделенном linked worktree, либо в primary checkout с точной
# trusted-аттестацией durable shared lease. Аттестация не передаётся provider-процессу.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/workspace-guard.sh"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/run-state.sh"

_instrumentation_tx_task_id() {
  local task=${1#[tT]}
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ ]] || return 2
  printf '%s\n' "$task"
}

instrumentation_tx_root() {
  local task control
  task=$(_instrumentation_tx_task_id "$1") || return
  control=$(factory_control_root) || return
  printf '%s/transactions/t%s\n' "$control" "$task"
}

instrumentation_tx_dir() {
  local task=$1 txid=${2:?transaction id}
  [[ "$txid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$ ]] || return 2
  printf '%s/%s\n' "$(instrumentation_tx_root "$task")" "$txid"
}

_instrumentation_tx_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' \
    "$file" 2>/dev/null
}

_instrumentation_tx_write_state() {
  local dir=$1 state=$2 checkpoint=${3:-0} reason=${4:-}
  local tmp isolation initial_digest="" checkpoint_digest=""
  if [[ -f "$dir/isolation" && ! -L "$dir/isolation" ]]; then
    isolation=$(<"$dir/isolation") || return 78
  elif [[ -f "$dir/state.env" && ! -L "$dir/state.env" ]]; then
    isolation=$(_instrumentation_tx_get "$dir/state.env" ISOLATION)
  else
    isolation=${FACTORY_INSTRUMENTATION_ISOLATION:-}
  fi
  [[ "$isolation" == exclusive-worktree-v1 ||
     "$isolation" == exclusive-shared-checkout-v1 ]] || return 78
  if [[ "$OSTYPE" == darwin* && "$checkpoint" == 0 ]]; then
    initial_digest=$(runtime_analytics_hash_file_v2 "$dir/baseline.tsv") || return 78
  elif [[ "$OSTYPE" == darwin* ]]; then
    checkpoint_digest=$(runtime_analytics_hash_file_v2 "$dir/checkpoint-$checkpoint.tsv") || return 78
  fi
  tmp=$(mktemp "$dir/.state.XXXXXX") || return 1
  {
    printf 'SCHEMA=1\nISOLATION=%s\nSTATE=%s\nCHECKPOINT=%s\n' \
      "$isolation" "$state" "$checkpoint"
    [[ -z "$reason" ]] || printf 'REASON=%s\n' "${reason//$'\n'/ }"
    [[ -z "$initial_digest" ]] || printf 'INITIAL_EXPECTED_SHA256=%s\n' "$initial_digest"
    [[ -z "$checkpoint_digest" ]] || printf 'CHECKPOINT_SHA256=%s\n' "$checkpoint_digest"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$dir/state.env"
}

_instrumentation_tx_sync_state() {
  local dir=$1
  # Сначала fsync файла после atomic rename, затем каталога с самой записью rename.
  # До успешного барьера cleanup не имеет права менять workspace.
  if [[ "$OSTYPE" == darwin* ]]; then
    _instrumentation_tx_native_directory "$dir" sync-tx-state
    return
  fi
  sync -f -- "$dir/state.env" &&
    sync -f -- "$dir"
}

# Helper открывает имя относительно переданного каталога. Граница не следует
# ссылкам внутри scope и отказывает при непроверенном родителе.
_instrumentation_tx_native_directory() {
  local parent=$1 operation=$2 helper=${FACTORY_DARWIN_PROCESS_HELPER:-}
  shift 2
  [[ "$parent" == /* && -d "$parent" && ! -L "$parent" &&
     "$(realpath -e -- "$parent")" == "$parent" &&
     "$helper" == /* && -x "$helper" && ! -L "$helper" ]] || return 78
  "$helper" "$operation" 3 "$@" 3<"$parent"
}

# Проверяет каждый объект уже восстановленного scope и Git index до нового
# снимка baseline. Ссылку и отсутствие объекта подтверждает fsync родителя.
_instrumentation_tx_sync_restored() {
  local dir=$1 path64 root64 relative64 kind rest absolute parent index exists
  while IFS=$'\t' read -r path64 root64 relative64 kind rest; do
    [[ -n "$path64" ]] || continue
    absolute=$(printf '%s' "$path64" | base64 -d) || return 78
    parent=$(dirname -- "$absolute") || return 78
    _instrumentation_tx_native_directory "$parent" sync-restored-object "$kind" "${absolute##*/}" ||
      return
  done <"$dir/files.tsv" || return
  while IFS=$'\t' read -r root64 index exists rest; do
    [[ -n "$index" ]] || continue
    case "$exists" in
      0) kind=missing ;;
      1) kind=file ;;
      *) return 78 ;;
    esac
    parent=$(dirname -- "$index") || return 78
    _instrumentation_tx_native_directory "$parent" sync-restored-object "$kind" "${index##*/}" ||
      return
  done <"$dir/indexes.tsv"
}

# Читает доверенную запись даже после снятия active.env. По другому attempt
# возвращает конфликт, поэтому Stop не может принять незакрытую старую запись.
_instrumentation_tx_finalization_read() {
  local task=$1 attempt=$2 root file fd metadata uid rc=0
  root=$(factory_control_root) || return
  root="$root/transaction-finalization"
  [[ -d "$root" && ! -L "$root" && "$(realpath -e -- "$root")" == "$root" ]] || return 78
  file="$root/t${task}.json"
  [[ -e "$file" || -L "$file" ]] || return 3
  [[ -f "$file" && ! -L "$file" ]] || return 78
  { exec {fd}<"$file"; } || return 78
  uid=$(id -u)
  metadata=$("$FACTORY_DARWIN_PROCESS_HELPER" runner-fd-stat 3 3<&"$fd") || metadata=
  if [[ "$metadata" != "$uid:600:1" ]]; then
    exec {fd}<&-
    return 78
  fi
  jq -cse --arg task "$task" --arg attempt "$attempt" '
    select(length == 1) | .[0] | select(type == "object" and
      (keys == ["attempt", "baseline", "format", "phase", "scope", "task", "txid"]) and
      .format == 1 and .task == $task and
      (.attempt | test("^a_[a-f0-9]{32}$")) and
      ((.attempt | sub("^a_"; "")) as $owner | (.txid | test("^v2-" + $owner + "-s[0-9]+$"))) and
      (.baseline | test("^[a-f0-9]{64}$")) and (.scope | test("^[a-f0-9]{64}$")) and
      (.phase == "pending" or .phase == "restored" or .phase == "synced") and
      (.attempt == $attempt or .phase == "synced"))
  ' <&"$fd" || rc=78
  exec {fd}<&-
  return "$rc"
}

# Публикация выполняется под TX lock. Повтор после сбоя fsync проверяет
# те же pinned baseline/scope и повторно синхронизирует уже видимое имя.
_instrumentation_tx_finalization_write() {
  local task=$1 attempt=$2 txid=$3 dir=$4 requested=$5
  local root file temp baseline scope current phase rc=0
  [[ "$attempt" =~ ^a_[a-f0-9]{32}$ && "$txid" =~ ^v2-${attempt#*_}-s[0-9]+$ ]] || return 78
  root=$(factory_control_root) || return
  root="$root/transaction-finalization"
  file="$root/t${task}.json"
  baseline=$(runtime_analytics_hash_file_v2 "$dir/baseline.tsv") || return 78
  scope=$(runtime_analytics_hash_file_v2 "$dir/scope.list") || return 78
  current=$(_instrumentation_tx_finalization_read "$task" "$attempt") || rc=$?
  if (( rc == 0 )); then
    phase=$(jq -er .phase <<<"$current") || return 78
    if jq -e --arg attempt "$attempt" --arg txid "$txid" --arg baseline "$baseline" --arg scope "$scope" \
      '.attempt == $attempt and .txid == $txid and .baseline == $baseline and .scope == $scope' \
      <<<"$current" >/dev/null; then
      if [[ "$phase" == "$requested" ||
            "$requested" == pending && "$phase" == restored ||
            "$phase" == synced ]]; then
        _instrumentation_tx_native_directory "$root" sync-restored-object file "${file##*/}"
        return
      fi
      [[ "$phase:$requested" == pending:restored || "$phase:$requested" == restored:synced ]] || return 78
    else
      [[ "$phase" == synced && "$requested" == pending ]] || return 78
    fi
  else
    (( rc == 3 )) && [[ "$requested" == pending ]] || return 78
  fi
  temp=$(mktemp "$root/.finalization.XXXXXX") || return 78
  jq -cn --arg task "$task" --arg attempt "$attempt" --arg txid "$txid" \
    --arg baseline "$baseline" --arg scope "$scope" --arg phase "$requested" \
    '{format:1, task:$task, attempt:$attempt, txid:$txid, baseline:$baseline, scope:$scope, phase:$phase}' \
    >"$temp" &&
    runtime_analytics_durable_replace_v2 "$temp" "$file" || rc=78
  rm -f -- "$temp"
  return "$rc"
}

# Связанный hook вызывает этот порт только после проверенного снимка стенда.
# Для профиля без hook можно завершить сразу после durable восстановления.
instrumentation_tx_finish_restore() {
  local task=$1 attempt=$2 txid=$3 dir lock_fd rc=0
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  if [[ "$(_instrumentation_tx_get "$dir/state.env" STATE)" != completed ]]; then
    rc=78
  elif ! _instrumentation_tx_finalization_write "$task" "$attempt" "$txid" "$dir" synced; then
    rc=78
  elif [[ "${FACTORY_DARWIN_EXPLICIT_STOP:-0}" == 1 ]]; then
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      manual-confirm "${dir%/*}" "$task" "$txid" || rc=$?
    if (( rc == 3 )); then
      rc=0
    fi
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_lock() {
  local task=$1 output_var=$2 root fd
  root=$(instrumentation_tx_root "$task") || return
  if [[ "$OSTYPE" == darwin* ]]; then
    python3 "$FACTORY_HOME/lib/darwin-owned-directory.py" "$root" "$(factory_control_root)" >/dev/null ||
      return 78
  else
    mkdir -p "$root"
  fi
  exec {fd}>"$root/.lock"
  flock "$fd" || {
    eval "exec ${fd}>&-"
    return 1
  }
  printf -v "$output_var" '%s' "$fd"
}

_instrumentation_tx_unlock() {
  local fd=$1
  flock -u "$fd" 2>/dev/null || true
  eval "exec ${fd}>&-"
}

instrumentation_tx_darwin_disposition() {
  local task=$1 txid=$2 root lock_fd rc=0
  root=$(instrumentation_tx_root "$task") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
    disposition "$root" "$task" "$txid" sync-retired || rc=$?
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_find_root() {
  local absolute=$1 roots_file=$2 root best=""
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" ]] || continue
    if [[ "$absolute" == "$root" || "$absolute" == "$root/"* ]]; then
      (( ${#root} > ${#best} )) && best=$root
    fi
  done <"$roots_file"
  [[ -n "$best" ]] || return 1
  printf '%s\n' "$best"
}

_instrumentation_tx_normalize_roots() {
  local output=$1
  shift
  local candidate root canonical
  {
    for candidate in "$@"; do
      root=$(workspace_guard_repo_root "$candidate" 2>/dev/null || true)
      [[ -n "$root" ]] || continue
      canonical=$(realpath -e -- "$root" 2>/dev/null || true)
      [[ -n "$canonical" ]] && printf '%s\n' "$canonical"
    done
  } | sort -u >"$output"
  [[ -s "$output" ]]
}

_instrumentation_tx_normalize_scope() {
  local input=$1 output=$2 roots_file=$3 absolute parent canonical_parent base normalized root
  : >"$output"
  while IFS= read -r absolute || [[ -n "$absolute" ]]; do
    [[ -n "$absolute" && "$absolute" == /* ]] || return 2
    [[ "$absolute" != *$'\t'* && "$absolute" != *$'\n'* ]] || return 2
    parent=$(dirname "$absolute")
    [[ -d "$parent" ]] || return 2
    canonical_parent=$(realpath -e -- "$parent" 2>/dev/null) || return 2
    base=$(basename "$absolute")
    [[ "$base" != "." && "$base" != ".." && "$base" != */* ]] || return 2
    normalized="$canonical_parent/$base"
    # Запрещаем lexical traversal, parent-symlink escape и symlink последнего
    # компонента: запись через такую ссылку изменила бы target вне scope.
    [[ "$absolute" == "$normalized" ]] || return 2
    root=$(_instrumentation_tx_find_root "$normalized" "$roots_file") || return 2
    [[ "$normalized" != "$root" ]] || return 2
    [[ "$normalized" != "$root/.git" && "$normalized" != "$root/.git/"* ]] || return 2
    [[ ! -L "$normalized" ]] || return 2
    [[ ! -d "$normalized" ]] || return 2
    printf '%s\n' "$normalized" >>"$output"
  done <"$input"
  sort -u -o "$output" "$output"
  [[ -s "$output" ]]
}

# Маркер ищется там, откуда он может уехать в диф: tracked-содержимое и untracked-файлы
# вне gitignore. Игнорируемые файлы не проверяются, и это исправление, а не послабление.
# Вывод самой трассировки приложение может писать ВНУТРЬ дерева (`runtime/logs/app.log`),
# поэтому требование «маркера нет ни в одном ignored файле» невыполнимо в принципе:
# прогон останавливался с `baseline_not_restored` из-за новых строк лога при побайтово
# восстановленном исходнике, а следующий `begin` отказывал 78 по тому же логу — узел нельзя было ни
# закрыть, ни переиграть. Это та же линия, по которой ignored сняты с надзора сторожа
# (см. _instrumentation_tx_snapshot): в коммит они не попадают и умирают вместе с
# песочницей. Попутно уходит обход vendor/node_modules — минуты на каждый begin и cleanup.
_instrumentation_tx_marker_absent_in_roots() {
  local dir=$1 marker root rel absolute
  marker=$(base64 -d <"$dir/marker.b64" 2>/dev/null || true)
  [[ -n "$marker" ]] || return 1
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" ]] || continue
    if [[ "$OSTYPE" == darwin* ]]; then
      _instrumentation_tx_darwin_marker_absent "$root" "$marker" || return
      continue
    fi
    if git -C "$root" grep -Fq -- "$marker" -- . 2>/dev/null; then
      return 78
    fi
    while IFS= read -r -d '' rel; do
      absolute="$root/$rel"
      [[ -f "$absolute" && ! -L "$absolute" ]] || continue
      grep -Fq -- "$marker" "$absolute" 2>/dev/null && return 78
    done < <(git -C "$root" ls-files --others --exclude-standard -z)
  done <"$dir/roots.list"
  return 0
}

_instrumentation_tx_verify_isolation() {
  local roots_file=$1 root git_dir common_dir isolation
  isolation=${FACTORY_INSTRUMENTATION_ISOLATION:-}
  case "$isolation" in
    exclusive-worktree-v1) ;;
    exclusive-shared-checkout-v1)
      declare -F instrumentation_tx_shared_lease_invariant >/dev/null || return 78
      instrumentation_tx_shared_lease_invariant "$roots_file" || return 75
      ;;
    *) return 78 ;;
  esac
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" ]] || continue
    git_dir=$(git -C "$root" rev-parse --path-format=absolute --git-dir 2>/dev/null) ||
      return 78
    common_dir=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
      return 78
    git_dir=$(realpath -e -- "$git_dir" 2>/dev/null) || return 78
    common_dir=$(realpath -e -- "$common_dir" 2>/dev/null) || return 78
    if [[ "$isolation" == exclusive-worktree-v1 ]]; then
      [[ "$git_dir" != "$common_dir" && "$git_dir" == "$common_dir/worktrees/"* ]] ||
        return 78
    else
      # Primary checkout допустим только после exact lease invariant выше.
      [[ "$git_dir" == "$common_dir" ]] || return 78
    fi
  done <"$roots_file"
}

_instrumentation_tx_backup_scope() {
  local dir=$1 marker=$2
  local absolute root rel path64 root64 rel64 type mode hash target64 backup id
  mkdir -p "$dir/backups"
  : >"$dir/files.tsv"
  while IFS= read -r absolute || [[ -n "$absolute" ]]; do
    root=$(_instrumentation_tx_find_root "$absolute" "$dir/roots.list") || return 2
    rel=${absolute#"$root/"}
    path64=$(printf '%s' "$absolute" | workspace_guard_b64)
    root64=$(printf '%s' "$root" | workspace_guard_b64)
    rel64=$(printf '%s' "$rel" | workspace_guard_b64)
    id=$(printf '%s' "$absolute" | workspace_guard_sha256_stream)
    target64="-"; backup="-"
    if [[ -L "$absolute" ]]; then
      type=symlink
      mode=$(stat -c '%a' -- "$absolute") || return 1
      target64=$(readlink -n -- "$absolute" | workspace_guard_b64) || return 1
      hash=$(readlink -n -- "$absolute" | workspace_guard_sha256_stream) || return 1
    elif [[ -f "$absolute" ]]; then
      type=file
      mode=$(stat -c '%a' -- "$absolute") || return 1
      hash=$(sha256sum -- "$absolute" | awk '{print $1}') || return 1
      if [[ -n "$marker" ]] && grep -Fq -- "$marker" "$absolute" 2>/dev/null; then
        return 78
      fi
      backup="backups/${id}.data"
      cp --reflink=auto --preserve=mode,timestamps -- "$absolute" "$dir/$backup" || return 1
      chmod 600 "$dir/$backup" 2>/dev/null || true
    elif [[ -e "$absolute" ]]; then
      return 2
    else
      type=missing
      mode=-; hash=-
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$path64" "$root64" "$rel64" "$type" "$mode" "$hash" "$target64" "$backup" \
      >>"$dir/files.tsv"
  done <"$dir/scope.list"
}

_instrumentation_tx_backup_indexes() {
  local dir=$1 root root64 index id exists mode hash backup
  if [[ "$OSTYPE" == darwin* ]]; then
    python3 "$FACTORY_HOME/lib/workspace-guard-darwin.py" backup-indexes "$dir"
    return
  fi
  mkdir -p "$dir/indexes"
  : >"$dir/indexes.tsv"
  while IFS= read -r root || [[ -n "$root" ]]; do
    root64=$(printf '%s' "$root" | workspace_guard_b64)
    index=$(git -C "$root" rev-parse --git-path index 2>/dev/null) || return 1
    [[ "$index" == /* ]] || index="$root/$index"
    id=$(printf '%s' "$root" | workspace_guard_sha256_stream)
    if [[ -f "$index" ]]; then
      exists=1
      mode=$(stat -c '%a' -- "$index") || return 1
      hash=$(sha256sum -- "$index" | awk '{print $1}') || return 1
      backup="indexes/${id}.index"
      cp --reflink=auto --preserve=mode,timestamps -- "$index" "$dir/$backup" || return 1
      chmod 600 "$dir/$backup" 2>/dev/null || true
    else
      exists=0; mode=-; hash=-; backup=-
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$root64" "$index" "$exists" "$mode" "$hash" "$backup" \
      >>"$dir/indexes.tsv"
  done <"$dir/roots.list"
}

# Ошибку Git или grep отличаем от отсутствия маркера на Darwin.
# Список untracked материализуется вне worktree до проверки отдельных файлов.
_instrumentation_tx_darwin_marker_absent() (
  local root=$1 marker=$2 rel absolute list rc=0
  list=$(mktemp /private/tmp/grigdesk-marker.XXXXXX) || return 78
  trap 'rm -f -- "$list"' EXIT
  workspace_guard_darwin_git_once "$root" grep -Fq -- "$marker" -- . || rc=$?
  (( rc == 1 )) || return 78
  workspace_guard_darwin_git_once "$root" ls-files --others --exclude-standard -z >"$list" || return 78
  while IFS= read -r -d '' rel; do
    absolute="$root/$rel"
    [[ -f "$absolute" && ! -L "$absolute" ]] || continue
    rc=0
    grep -Fq -- "$marker" "$absolute" || rc=$?
    (( rc == 1 )) || return 78
  done <"$list"
)

# Чувствительное множество снимка — это ТОЛЬКО scope: записи по нему нужны cleanup-у,
# чтобы доказать, что инструментация восстановлена побайтово. Правки исходников ловятся
# не отсюда: записи TRACKED_WORKTREE, TRACKED_INDEX и UNTRACKED workspace_guard строит
# прямо из состояния git, независимо от этого списка.
#
# Раньше сюда добавлялись ВСЕ игнорируемые git файлы каждого корня — чтобы агент не прятал
# правки в .env, vendor и node_modules. От намеренного подлога это не защищало никогда:
# сторож сравнивает две точки (begin и checkpoint), и всё, что изменили и вернули между
# ними, для него не существует — достаточно откатить .env перед завершением этапа. Зато
# ложные срабатывания шли потоком: стенд поднят всю транзакцию (узел вроде TRACE ради
# живого прогона и существует), и его мусор сторожу неотличим от правки. Список исключений
# PROFILE_VOLATILE_PATHS оказался списком шрамов — в него попадало ровно то, на чём уже
# умер прогон: runtime-дампы, трассы браузера и кэши внутри каталогов зависимостей. Следующая
# разновидность generated-файлов всё равно оставалась неучтённой, а добавлять целиком каталоги
# зависимостей запрещено намеренно. Догнать инструменты перечислением невозможно.
#
# Проверка показала, чего этот надзор стоил и что защищал: env-файлы, runtime-данные,
# зависимости и build cache имели nlink=1 — это копии песочницы, они исчезают вместе с ней
# и в диф не попадают никогда. Единственным исключением был общий каталог зависимостей:
# профиль клонировал
# его через `cp -al`, и запись в песочнице меняла файлы основного репозитория и всех соседних
# деревьев разом. Но это дефект провижна, а не предмет надзора, и чинится он в профиле полной
# копией. Небольшая цена копирования нужна ради изоляции inode. Отсюда требование к профилю: рабочее дерево
# обязано быть самодостаточным, без общих inode с чем-либо вне песочницы — см. PROFILE-CONTRACT.
_instrumentation_tx_snapshot() {
  local dir=$1 output=$2 sensitive rc
  local -a roots=()
  mapfile -t roots <"$dir/roots.list"
  (( ${#roots[@]} > 0 )) || return 2
  sensitive=$(mktemp "$dir/.snapshot-sensitive.XXXXXX") || return 1
  cp -- "$dir/scope.list" "$sensitive" || {
    rm -f -- "$sensitive"
    return 1
  }
  sort -u -o "$sensitive" "$sensitive"
  WORKSPACE_GUARD_SENSITIVE_LIST_FILE="$sensitive" \
    workspace_guard_snapshot "$output" "${roots[@]}"
  rc=$?
  rm -f -- "$sensitive"
  return "$rc"
}

_instrumentation_tx_scope_objects_safe() {
  local dir=$1 path64 root64 rel64 type mode hash target64 backup absolute parent
  local canonical_parent
  while IFS=$'\t' read -r path64 root64 rel64 type mode hash target64 backup; do
    [[ -n "$path64" ]] || continue
    absolute=$(printf '%s' "$path64" | base64 -d) || return 78
    parent=$(dirname "$absolute")
    [[ -d "$parent" && ! -L "$parent" ]] || return 75
    canonical_parent=$(realpath -e -- "$parent" 2>/dev/null) || return 75
    [[ "$canonical_parent" == "$parent" ]] || return 75
    # Scope допускает только regular file или отсутствие. Symlink даже внутри
    # разрешённого пути способен перенаправить запись за пределы worktree.
    [[ ! -L "$absolute" ]] || return 75
    [[ ! -e "$absolute" || -f "$absolute" ]] || return 75
  done <"$dir/files.tsv"
}

# При возобновлении cleanup workspace закономерно является смесью двух снимков:
# часть объектов уже восстановлена до baseline, часть ещё совпадает с expected.
# Aggregate hashes исключены — смешанное состояние не обязано иметь aggregate hash
# ни одного из полных снимков; все составляющие проверяются per-path ниже.
_instrumentation_tx_snapshot_is_expected_or_baseline() {
  local expected=$1 baseline=$2 current=$3
  [[ -f "$expected" && -f "$baseline" && -f "$current" ]] || return 2
  awk -F'\t' '
    function record_key(    kind) {
      kind = $1
      if (kind == "WORKTREE_DIFF" || kind == "INDEX_DIFF") return ""
      if (kind == "SCHEMA") return kind
      if (kind == "ROOT" || kind == "HEAD") return kind SUBSEP $2
      if (kind == "TRACKED_WORKTREE" || kind == "TRACKED_INDEX" ||
          kind == "UNTRACKED" || kind == "SENSITIVE") {
        return kind SUBSEP $2 SUBSEP $3
      }
      invalid = 1
      return ""
    }
    FNR == 1 { part++ }
    {
      key = record_key()
      if (key == "") next
      keys[key] = 1
      if (part == 1) {
        if (key in seen_expected) invalid = 1
        seen_expected[key] = 1
        expected[key] = $0
      } else if (part == 2) {
        if (key in seen_baseline) invalid = 1
        seen_baseline[key] = 1
        baseline[key] = $0
      } else if (part == 3) {
        if (key in seen_current) invalid = 1
        seen_current[key] = 1
        current[key] = $0
      } else {
        invalid = 1
      }
    }
    END {
      if (invalid || part != 3) exit 2
      for (key in keys) {
        current_value = ((key in seen_current) ? "P" current[key] : "A")
        expected_value = ((key in seen_expected) ? "P" expected[key] : "A")
        baseline_value = ((key in seen_baseline) ? "P" baseline[key] : "A")
        if (current_value != expected_value && current_value != baseline_value) exit 1
      }
    }
  ' "$expected" "$baseline" "$current"
}

# instrumentation_tx_begin <task> <txid> <scope-list> <marker> <git-root>...
instrumentation_tx_begin() {
  local task=$1 txid=$2 scope_input=$3 marker=$4 task_id
  shift 4
  task_id=$(_instrumentation_tx_task_id "$task") || return
  [[ "$marker" == "FACTORY-TRACE:t${task_id}" ]] || return 2
  [[ -f "$scope_input" && $# -gt 0 ]] || return 2
  local root dir lock_fd active tmp rc
  root=$(instrumentation_tx_root "$task")
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  if [[ "$OSTYPE" == darwin* ]]; then
    rc=0
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" recover "$root" "$task_id" "$txid" || rc=$?
    if (( rc != 3 )); then
      _instrumentation_tx_unlock "$lock_fd"
      return "$rc"
    fi
  fi
  active="$root/active.env"
  if [[ -f "$active" ]]; then
    _instrumentation_tx_unlock "$lock_fd"
    return 73
  fi
  [[ ! -e "$dir" ]] || {
    _instrumentation_tx_unlock "$lock_fd"
    return 73
  }

  tmp=$(mktemp -d "$root/.tx.XXXXXX") || {
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  chmod 700 "$tmp"
  printf '%s\n' "${FACTORY_INSTRUMENTATION_ISOLATION:-}" >"$tmp/isolation" || {
    rm -rf -- "$tmp"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  chmod 400 "$tmp/isolation" || {
    rm -rf -- "$tmp"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  if [[ "$OSTYPE" == darwin* ]]; then
    local node=${FACTORY_INSTRUMENTATION_CURSOR_NODE:-} sequence=${FACTORY_INSTRUMENTATION_CURSOR_SEQUENCE:-}
    if [[ ! "$node" =~ ^[a-z0-9][a-z0-9_]{0,40}$ || ! "$sequence" =~ ^(0|[1-9][0-9]{0,17})$ ]] ||
       ! printf 'NODE=%s\nSEQUENCE=%s\n' "$node" "$sequence" >"$tmp/cursor.env"; then
      rm -rf -- "$tmp"
      _instrumentation_tx_unlock "$lock_fd"
      return 78
    fi
  fi
  _instrumentation_tx_normalize_roots "$tmp/roots.list" "$@" &&
    _instrumentation_tx_normalize_scope "$scope_input" "$tmp/scope.list" "$tmp/roots.list" &&
    _instrumentation_tx_verify_isolation "$tmp/roots.list" &&
    printf '%s' "$marker" | workspace_guard_b64 >"$tmp/marker.b64" &&
    _instrumentation_tx_marker_absent_in_roots "$tmp" &&
    _instrumentation_tx_backup_scope "$tmp" "$marker" &&
    _instrumentation_tx_backup_indexes "$tmp" &&
    _instrumentation_tx_snapshot "$tmp" "$tmp/baseline.tsv"
  rc=$?
  if (( rc != 0 )); then
    rm -rf -- "$tmp"
    _instrumentation_tx_unlock "$lock_fd"
    return "$rc"
  fi

  _instrumentation_tx_write_state "$tmp" active 0 || {
    rm -rf -- "$tmp"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  if [[ "$OSTYPE" == darwin* ]]; then
    rc=0
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      publish "$root" "$task_id" "$txid" "$tmp" || rc=$?
    _instrumentation_tx_unlock "$lock_fd"
    return "$rc"
  fi
  mv -- "$tmp" "$dir" || {
    rm -rf -- "$tmp"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  tmp=$(mktemp "$root/.active.XXXXXX") || {
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  printf 'SCHEMA=1\nTRANSACTION_ID=%s\n' "$txid" >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$active"
  _instrumentation_tx_unlock "$lock_fd"
}

# Verifier используется под тем же TX lock, включая retry после видимого
# state/active. Mutating Stop не может завершить неполный begin через него.
_instrumentation_tx_verify_darwin_begin() {
  local task=$1 txid=$2 root
  root=$(instrumentation_tx_root "$task") || return
  python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" verify "$root" "$task" "$txid"
}

instrumentation_tx_ensure_darwin_begin() {
  local task=$1 txid=$2 root lock_fd rc=0
  root=$(instrumentation_tx_root "$task") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" recover "$root" "$task" "$txid" || rc=$?
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

# Только для уже видимого TX. Подготовленный temp не становится TX при Stop.
instrumentation_tx_recover_published_darwin_begin() {
  local task=$1 attempt=$2 root lock_fd result txid rc=0
  root=$(instrumentation_tx_root "$task") || return
  [[ -e "$root" || -L "$root" ]] || return 3
  _instrumentation_tx_lock "$task" lock_fd || return
  result=$(python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
    pending "$root" "$task" "$attempt") || rc=$?
  if (( rc == 0 )); then
    txid=${result%% *}
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      recover-published "$root" "$task" "$txid" || rc=$?
    if (( rc == 0 )); then
      printf '%s\n' "$txid"
    fi
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

instrumentation_tx_resume_darwin_begin() {
  local task=$1 attempt=$2 node=$3 sequence=$4 root lock_fd result txid rc=0
  root=$(instrumentation_tx_root "$task") || return
  [[ -e "$root" || -L "$root" ]] || return 3
  _instrumentation_tx_lock "$task" lock_fd || return
  if [[ -e "$root/active.env" || -L "$root/active.env" ]]; then
    txid=$(_route_v2_transaction_active_id "$task") || rc=$?
  else
    result=$(python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      pending "$root" "$task" "$attempt" sync-retired) || rc=$?
    txid=${result%% *}
  fi
  if (( rc == 0 )); then
    if [[ "$txid" =~ ^v2-${attempt#*_}-s[0-9]+$ ]]; then
      python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
        resume-to-cursor "$root" "$task" "$txid" "$node" "$sequence" || rc=$?
    else
      rc=78
    fi
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

# Stop до первой публикации сохраняет подготовленные входы и подтверждает
# только отсутствие допуска. Снимок в scratch не создаёт настоящий TX.
instrumentation_tx_retire_darwin_begin() {
  local task=$1 attempt=$2 root lock_fd result txid temporary scratch rc=0
  root=$(instrumentation_tx_root "$task") || return
  [[ -e "$root" || -L "$root" ]] || return 3
  _instrumentation_tx_lock "$task" lock_fd || return
  result=$(python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
    pending "$root" "$task" "$attempt" sync-retired) || rc=$?
  if (( rc != 0 )); then
    _instrumentation_tx_unlock "$lock_fd"
    return "$rc"
  fi
  read -r txid temporary <<<"$result"
  if ! runner_darwin_intent_absent "$task"; then
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  fi
  runner_trusted_identity_read "$task" >/dev/null && rc=0 || rc=$?
  if (( rc != 3 )); then
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  fi
  scratch=$(mktemp /private/tmp/grigdesk-retirement.XXXXXX) || {
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  }
  rc=0
  _instrumentation_tx_snapshot "$root/$temporary" "$scratch" &&
    _instrumentation_tx_marker_absent_in_roots "$root/$temporary" &&
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      retire "$root" "$task" "$txid" "$scratch" || rc=78
  rm -f -- "$scratch"
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

instrumentation_tx_checkpoint() {
  local task=$1 txid=$2 dir lock_fd rc=0
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  if [[ "$OSTYPE" == darwin* ]]; then
    _instrumentation_tx_checkpoint_darwin "$task" "$txid" "$dir" "${3:-result}" || rc=$?
  else
    _instrumentation_tx_checkpoint_linux "$dir" || rc=$?
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_checkpoint_linux() {
  local dir=$1 state checkpoint next tmp
  state=$(_instrumentation_tx_get "$dir/state.env" STATE)
  [[ "$state" == active ]] || return 73
  checkpoint=$(_instrumentation_tx_get "$dir/state.env" CHECKPOINT)
  [[ "$checkpoint" =~ ^[0-9]+$ ]] || checkpoint=0
  next=$((checkpoint + 1))
  tmp="$dir/checkpoint-${next}.tsv"
  if ! _instrumentation_tx_scope_objects_safe "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "unsafe_scope_object"
    return 75
  fi
  _instrumentation_tx_snapshot "$dir" "$tmp" || {
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "snapshot_failed"
    return 1
  }
  if ! workspace_guard_compare_scoped "$dir/baseline.tsv" "$tmp" "$dir/scope.list"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "out_of_scope_change"
    return 75
  fi
  cp -- "$tmp" "$dir/.expected.next"
  chmod 600 "$dir/.expected.next"
  mv -f -- "$dir/.expected.next" "$dir/expected.tsv"
  _instrumentation_tx_write_state "$dir" active "$next"
}

_instrumentation_tx_darwin_dispatch() {
  local action=$1 task=$2 txid=$3 root
  shift 3
  root=$(instrumentation_tx_root "$task") || return
  python3 "$FACTORY_HOME/lib/darwin-transaction-dispatch.py" "$action" "$root" "$task" "$txid" \
    "${FACTORY_DARWIN_PROCESS_HELPER:-}" "$@"
}

instrumentation_tx_darwin_permit() {
  local task=$1 txid=$2 lock_fd rc=0
  shift 2
  _instrumentation_tx_lock "$task" lock_fd || return
  if ! _instrumentation_tx_verify_darwin_begin "$task" "$txid" ||
     ! _instrumentation_tx_darwin_dispatch publish "$task" "$txid" "$@"; then
    rc=78
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_checkpoint_darwin() {
  local task=$1 txid=$2 dir=$3 caller=$4 selection phase next tmp rc=0
  _instrumentation_tx_verify_darwin_begin "$task" "$txid" || return 78
  selection=$(_instrumentation_tx_darwin_dispatch select "$task" "$txid") || return 78
  case "$selection" in
    none)
      [[ "$caller" == admission || "$caller" == cleanup ]] || return 78
      if [[ "$caller" == admission ]]; then
        _instrumentation_tx_verify_undispatched "$task" "$txid" "$dir" || return
      fi
      return 0
      ;;
    done) return 0 ;;
    'commit '*|'snapshot '*) read -r phase next <<<"$selection" ;;
    *) return 78 ;;
  esac
  tmp=$(mktemp "$dir/.checkpoint.XXXXXX") || return 78
  if ! _instrumentation_tx_scope_objects_safe "$dir" ||
     ! _instrumentation_tx_snapshot "$dir" "$tmp" ||
     ! workspace_guard_compare_scoped "$dir/baseline.tsv" "$tmp" "$dir/scope.list"; then
    rc=78
  elif [[ "$phase" == commit ]]; then
    _instrumentation_tx_darwin_dispatch resume-commit "$task" "$txid" "$next" "$tmp" || rc=78
  elif ! _instrumentation_tx_darwin_dispatch prepare "$task" "$txid" "$next" "$tmp" ||
       ! _instrumentation_tx_write_state "$dir" active "$next" ||
       ! _instrumentation_tx_darwin_dispatch commit "$task" "$txid" "$next"; then
    rc=78
  fi
  rm -f -- "$tmp"
  return "$rc"
}

_instrumentation_tx_verify_undispatched() {
  local task=$1 txid=$2 dir=$3 root scratch rc=0
  root=$(instrumentation_tx_root "$task") || return
  scratch=$(mktemp "$dir/.initial-check.XXXXXX") || return 78
  if ! _instrumentation_tx_scope_objects_safe "$dir" ||
     ! _instrumentation_tx_snapshot "$dir" "$scratch" ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$scratch" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir" ||
     ! python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" verify-initial-indexes "$root" "$task" "$txid"; then
    rc=78
  fi
  rm -f -- "$scratch"
  return "$rc"
}

# Проверка перед внешним действием повторяется после hook до synced.
instrumentation_tx_verify_restored_darwin() {
  local task=$1 txid=$2 dir scratch lock_fd rc=0
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  if ! _instrumentation_tx_verify_darwin_begin "$task" "$txid" ||
     [[ "$(_instrumentation_tx_get "$dir/state.env" STATE)" != completed ]]; then
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  fi
  scratch=$(mktemp "$dir/.restore-check.XXXXXX") || {
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  }
  if ! _instrumentation_tx_scope_objects_safe "$dir" ||
     ! _instrumentation_tx_snapshot "$dir" "$scratch" ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$scratch" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir" ||
     ! python3 "$FACTORY_HOME/lib/darwin-stand-snapshot.py" verify-indexes "$dir"; then
    rc=78
  fi
  rm -f -- "$scratch"
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_restore_files() {
  local dir=$1
  local path64 root64 rel64 type mode hash target64 backup absolute parent tmp target
  while IFS=$'\t' read -r path64 root64 rel64 type mode hash target64 backup; do
    [[ -n "$path64" ]] || continue
    absolute=$(printf '%s' "$path64" | base64 -d) || return 1
    parent=$(dirname "$absolute")
    [[ -d "$parent" ]] || return 75
    case "$type" in
      missing)
        [[ ! -d "$absolute" ]] || return 75
        rm -f -- "$absolute" || return 1
        _instrumentation_tx_restore_object_done || return
        ;;
      file)
        tmp=$(mktemp "$parent/.instrumentation-restore.XXXXXX") || return 1
        cp -- "$dir/$backup" "$tmp" || {
          rm -f -- "$tmp"
          return 1
        }
        chmod "$mode" "$tmp" || {
          rm -f -- "$tmp"
          return 1
        }
        mv -f -- "$tmp" "$absolute" || {
          rm -f -- "$tmp"
          return 1
        }
        _instrumentation_tx_restore_object_done || return
        ;;
      symlink)
        target=$(printf '%s' "$target64" | base64 -d) || return 1
        tmp="$parent/.instrumentation-link.$$"
        rm -f -- "$tmp"
        ln -s -- "$target" "$tmp" || return 1
        mv -Tf -- "$tmp" "$absolute" || {
          rm -f -- "$tmp"
          return 1
        }
        _instrumentation_tx_restore_object_done || return
        ;;
      *) return 2 ;;
    esac
  done <"$dir/files.tsv"
}

_instrumentation_tx_restore_indexes() {
  local dir=$1 root64 index exists mode hash backup tmp
  while IFS=$'\t' read -r root64 index exists mode hash backup; do
    [[ -n "$index" ]] || continue
    if [[ "$exists" == 1 ]]; then
      tmp=$(mktemp "$(dirname "$index")/.instrumentation-index.XXXXXX") || return 1
      cp -- "$dir/$backup" "$tmp" || {
        rm -f -- "$tmp"
        return 1
      }
      chmod "$mode" "$tmp" || {
        rm -f -- "$tmp"
        return 1
      }
      mv -f -- "$tmp" "$index" || {
        rm -f -- "$tmp"
        return 1
      }
    else
      rm -f -- "$index" || return 1
    fi
    _instrumentation_tx_restore_object_done || return
  done <"$dir/indexes.tsv"
}

_instrumentation_tx_restore_object_done() {
  local limit
  [[ "${FACTORY_TESTING:-0}" == 1 ]] || return 0
  limit=${FACTORY_INSTRUMENTATION_TEST_CRASH_AFTER_RESTORE_OBJECTS:-}
  [[ -n "$limit" ]] || return 0
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || return 2
  INSTRUMENTATION_TX_RESTORE_COUNT=$((INSTRUMENTATION_TX_RESTORE_COUNT + 1))
  if (( INSTRUMENTATION_TX_RESTORE_COUNT >= limit )); then
    # Только fault-injection offline-теста. SIGKILL моделирует исчезновение процесса:
    # вызывающий cleanup код не успевает записать stalled или completed.
    kill -KILL "$BASHPID"
  fi
}

_instrumentation_tx_marker_absent() {
  local dir=$1 marker absolute path64 rest
  marker=$(base64 -d <"$dir/marker.b64" 2>/dev/null || true)
  [[ -n "$marker" ]] || return 0
  while IFS=$'\t' read -r path64 rest; do
    absolute=$(printf '%s' "$path64" | base64 -d) || return 1
    [[ -f "$absolute" && ! -L "$absolute" ]] || continue
    grep -Fq -- "$marker" "$absolute" 2>/dev/null && return 1
  done <"$dir/files.tsv"
  return 0
}

# На Darwin Git locks удерживаются от проверки снимка до завершающего fsync.
# Linux использует тот же TX lock, как и прежде.
instrumentation_tx_cleanup() {
  local task=$1 txid=$2 attempt=${3:-} dir root lock_fd state owner=$BASHPID
  local git_locked=0 rc=0 lock_tool="$FACTORY_HOME/lib/workspace-index-locks.py"
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  if [[ "$OSTYPE" == darwin* && ( ! -d "$dir" || -L "$dir" || -L "$dir/state.env" ) ]]; then
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  fi
  if [[ "$OSTYPE" == darwin* ]] && ! _instrumentation_tx_verify_darwin_begin "$task" "$txid"; then
    _instrumentation_tx_unlock "$lock_fd"
    return 78
  fi
  state=$(_instrumentation_tx_get "$dir/state.env" STATE)
  if [[ "$OSTYPE" == darwin* && ( "$state" == active || "$state" == cleaning || "$state" == stalled ) ]]; then
    if ! python3 "$lock_tool" acquire "$dir" "$owner"; then
      _instrumentation_tx_unlock "$lock_fd"
      return 75
    fi
    git_locked=1
  elif [[ "$OSTYPE" == darwin* && "$state" == completed ]]; then
    if ! python3 "$lock_tool" retire-completed "$dir" "$owner"; then
      _instrumentation_tx_unlock "$lock_fd"
      return 75
    fi
  fi
  _instrumentation_tx_cleanup_locked "$task" "$txid" "$attempt" "$dir" "$state" "$owner" || rc=$?
  if (( git_locked )) && ! python3 "$lock_tool" release "$dir" "$owner"; then
    (( rc != 0 )) || rc=76
  fi
  if (( rc == 0 )) && [[ "$OSTYPE" == darwin* ]]; then
    root=$(instrumentation_tx_root "$task") &&
      _instrumentation_tx_native_directory "$root" clear-tx-pointer "$txid" &&
      _instrumentation_tx_finalization_write "$task" "$attempt" "$txid" "$dir" restored || rc=76
  fi
  _instrumentation_tx_unlock "$lock_fd"
  return "$rc"
}

_instrumentation_tx_cleanup_locked() {
  local task=$1 txid=$2 attempt=$3 dir=$4 state=$5 owner=$6
  local root checkpoint current final rc active expected
  local INSTRUMENTATION_TX_RESTORE_COUNT=0
  root=$(instrumentation_tx_root "$task") || return
  checkpoint=$(_instrumentation_tx_get "$dir/state.env" CHECKPOINT)
  expected="$dir/expected.tsv"
  if [[ "$OSTYPE" == darwin* ]]; then
    [[ "$checkpoint" =~ ^[0-9]{1,18}$ ]] || return 78
    if [[ "$checkpoint" == 0 ]]; then
      expected="$dir/baseline.tsv"
    else
      expected="$dir/checkpoint-$checkpoint.tsv"
    fi
  fi
  active="$root/active.env"
  if [[ "$state" == completed ]]; then
    # Crash мог произойти после durable terminal state, но до удаления mutable pointer.
    # Повтор cleanup безопасно завершает только этот остаточный шаг.
    if [[ "$OSTYPE" == darwin* ]]; then
      _instrumentation_tx_sync_state "$dir"
      return
    elif [[ "$(_instrumentation_tx_get "$active" TRANSACTION_ID)" == "$txid" ]]; then
      rm -f -- "$active"
    fi
    return 0
  fi
  if [[ "$OSTYPE" == darwin* && "$state" == stalled && "${FACTORY_DARWIN_EXPLICIT_STOP:-0}" == 1 ]]; then
    _instrumentation_tx_certify_manual_restore "$task" "$attempt" "$txid" "$dir" "$checkpoint"
    return
  fi
  [[ ( "$state" == active || "$state" == cleaning ) && -f "$expected" ]] || {
    return 73
  }
  if [[ "$OSTYPE" == darwin* ]] &&
     ! python3 "$FACTORY_HOME/lib/workspace-index-locks.py" verify "$dir" "$owner" "$checkpoint"; then
    return 75
  fi

  if [[ "$OSTYPE" == darwin* && "$checkpoint" == 0 ]]; then
    _instrumentation_tx_complete_before_dispatch "$task" "$attempt" "$txid" "$dir" "$state"
    return
  fi

  if ! _instrumentation_tx_scope_objects_safe "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "unsafe_scope_object"
    return 75
  fi

  current="$dir/cleanup-current.tsv"
  _instrumentation_tx_snapshot "$dir" "$current" || {
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "cleanup_snapshot_failed"
    return 1
  }

  if [[ "$state" == active ]]; then
    if ! workspace_guard_compare "$expected" "$current"; then
      _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "concurrent_change"
      return 75
    fi
    # Durable cleaning state публикуется до первой операции restore. После SIGKILL
    # повторный cleanup отличает штатную частичную очистку от чужой правки.
    _instrumentation_tx_write_state "$dir" cleaning "$checkpoint" ||
      {
        return 1
      }
    if [[ "$OSTYPE" != darwin* ]] && ! _instrumentation_tx_sync_state "$dir"; then
      return 1
    fi
  else
    _instrumentation_tx_snapshot_is_expected_or_baseline \
      "$expected" "$dir/baseline.tsv" "$current"
    rc=$?
    if (( rc != 0 )); then
      _instrumentation_tx_write_state "$dir" stalled "$checkpoint" \
        "cleanup_resume_conflict"
      return 75
    fi
  fi

  if [[ "$OSTYPE" == darwin* ]] &&
     { ! _instrumentation_tx_sync_state "$dir" ||
       ! _instrumentation_tx_finalization_write "$task" "$attempt" "$txid" "$dir" pending; }; then
    return 1
  fi

  rc=0
  if _instrumentation_tx_restore_files "$dir"; then
    if [[ "$OSTYPE" == darwin* ]]; then
      python3 "$FACTORY_HOME/lib/workspace-index-locks.py" restore "$dir" "$owner" "$checkpoint" || rc=$?
    else
      _instrumentation_tx_restore_indexes "$dir" || rc=$?
    fi
  else
    rc=$?
  fi
  if (( rc != 0 )); then
    if [[ "$OSTYPE" != darwin* ]]; then
      _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "restore_failed"
    fi
    return "$rc"
  fi

  if [[ "$OSTYPE" == darwin* ]] && ! _instrumentation_tx_sync_restored "$dir"; then
    return 1
  fi

  final="$dir/cleanup-final.tsv"
  _instrumentation_tx_snapshot "$dir" "$final" || rc=1
  if (( ${rc:-0} != 0 )) ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$final" ||
     ! _instrumentation_tx_marker_absent "$dir" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "baseline_not_restored"
    return 75
  fi

  _instrumentation_tx_write_state "$dir" completed "$checkpoint" ||
    {
      return 1
    }
  _instrumentation_tx_sync_state "$dir" || {
    return 1
  }
  if [[ "$OSTYPE" != darwin* && "$(_instrumentation_tx_get "$active" TRANSACTION_ID)" == "$txid" ]]; then
    rm -f -- "$active"
  fi
}

# До первого допуска закрывается та же TX с K=0. При drift остаётся pending,
# и ни один объект рабочего дерева или index не заменяется.
_instrumentation_tx_complete_before_dispatch() {
  local task=$1 attempt=$2 txid=$3 dir=$4 state=$5 scratch selection rc=0
  [[ "$state" == active ]] || return 78
  selection=$(_instrumentation_tx_darwin_dispatch select "$task" "$txid") || return 78
  [[ "$selection" == none ]] || return 78
  scratch=$(mktemp "$dir/.undispatched.XXXXXX") || return 78
  if ! _instrumentation_tx_scope_objects_safe "$dir" ||
     ! _instrumentation_tx_snapshot "$dir" "$scratch" ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$scratch" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir" ||
     ! _instrumentation_tx_finalization_write "$task" "$attempt" "$txid" "$dir" pending ||
     ! _instrumentation_tx_write_state "$dir" completed 0 ||
     ! _instrumentation_tx_sync_state "$dir"; then
    rc=78
  fi
  rm -f -- "$scratch"
  return "$rc"
}

# Явный Stop лишь подтверждает уже восстановленные человеком bytes и index.
_instrumentation_tx_certify_manual_restore() {
  local task=$1 attempt=$2 txid=$3 dir=$4 checkpoint=$5 scratch rc=0
  scratch=$(mktemp "$dir/.manual-stop.XXXXXX") || return 78
  if ! _instrumentation_tx_scope_objects_safe "$dir" ||
     ! _instrumentation_tx_snapshot "$dir" "$scratch" ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$scratch" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir" ||
     ! python3 "$FACTORY_HOME/lib/darwin-stand-snapshot.py" verify-indexes "$dir" ||
     ! python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
       manual-require "${dir%/*}" "$task" "$txid" "$scratch" ||
     ! _instrumentation_tx_finalization_write "$task" "$attempt" "$txid" "$dir" pending ||
     ! _instrumentation_tx_write_state "$dir" completed "$checkpoint" ||
     ! _instrumentation_tx_sync_state "$dir"; then
    rc=78
  fi
  rm -f -- "$scratch"
  return "$rc"
}
