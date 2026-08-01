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
# begin разрешён только в выделенном linked worktree, который trusted host зарезервировал
# исключительно для этой попытки. Аттестация не передаётся provider-процессу.

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
  local tmp
  tmp=$(mktemp "$dir/.state.XXXXXX") || return 1
  {
    printf 'SCHEMA=1\nISOLATION=exclusive-worktree-v1\nSTATE=%s\nCHECKPOINT=%s\n' \
      "$state" "$checkpoint"
    [[ -z "$reason" ]] || printf 'REASON=%s\n' "${reason//$'\n'/ }"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$dir/state.env"
}

_instrumentation_tx_sync_state() {
  local dir=$1
  # Сначала fsync файла после atomic rename, затем каталога с самой записью rename.
  # До успешного барьера cleanup не имеет права менять workspace.
  sync -f -- "$dir/state.env" &&
    sync -f -- "$dir"
}

_instrumentation_tx_lock() {
  local task=$1 output_var=$2 root fd
  root=$(instrumentation_tx_root "$task")
  mkdir -p "$root"
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

_instrumentation_tx_marker_absent_in_roots() {
  local dir=$1 marker root rel absolute
  marker=$(base64 -d <"$dir/marker.b64" 2>/dev/null || true)
  [[ -n "$marker" ]] || return 1
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" ]] || continue
    if git -C "$root" grep -Fq -- "$marker" -- . 2>/dev/null; then
      return 78
    fi
    while IFS= read -r -d '' rel; do
      absolute="$root/$rel"
      [[ -f "$absolute" && ! -L "$absolute" ]] || continue
      grep -Fq -- "$marker" "$absolute" 2>/dev/null && return 78
    done < <(git -C "$root" ls-files --others --exclude-standard -z)
    # Маркер в ignored source-файле так же опасен, как в tracked/untracked. Артефакты
    # трассировки должны жить вне source roots, поэтому ignored не является исключением.
    while IFS= read -r -d '' rel; do
      absolute="$root/$rel"
      [[ -f "$absolute" && ! -L "$absolute" ]] || continue
      grep -Fq -- "$marker" "$absolute" 2>/dev/null && return 78
    done < <(git -C "$root" ls-files --others --ignored --exclude-standard -z)
  done <"$dir/roots.list"
  return 0
}

_instrumentation_tx_verify_isolation() {
  local roots_file=$1 root git_dir common_dir
  [[ "${FACTORY_INSTRUMENTATION_ISOLATION:-}" == exclusive-worktree-v1 ]] || return 78
  while IFS= read -r root || [[ -n "$root" ]]; do
    [[ -n "$root" ]] || continue
    git_dir=$(git -C "$root" rev-parse --path-format=absolute --git-dir 2>/dev/null) ||
      return 78
    common_dir=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
      return 78
    git_dir=$(realpath -e -- "$git_dir" 2>/dev/null) || return 78
    common_dir=$(realpath -e -- "$common_dir" 2>/dev/null) || return 78
    # Primary checkout имеет git-dir == common-dir. Для транзакции нужен отдельный
    # linked worktree; эксклюзивную аренду этого пути гарантирует trusted host.
    [[ "$git_dir" != "$common_dir" && "$git_dir" == "$common_dir/worktrees/"* ]] ||
      return 78
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

# Глобы изменчивых путей замораживаются в транзакции рядом с roots.list и scope.list.
# Читать их на каждом снимке прямо из профиля нельзя: снимки ОДНОЙ транзакции обязаны
# сравниваться байт в байт, а профиль между заходами могли и поправить — тогда baseline
# и checkpoint разошлись бы на пустом месте и дали ложное readonly-нарушение.
_instrumentation_tx_write_volatile() {
  local output=$1 glob
  local -a globs=()
  # read -a расщепляет по IFS и НЕ раскрывает глобы (в отличие от `for g in $VAR`,
  # который развернул бы `storage/logs/*` по текущему каталогу).
  read -r -a globs <<<"${PROFILE_VOLATILE_PATHS:-}"
  : >"$output" || return 1
  for glob in ${globs[@]+"${globs[@]}"}; do
    [[ -n "$glob" ]] || continue
    [[ "$glob" != /* ]] || return 78
    printf '%s\n' "$glob" >>"$output"
  done
  return 0
}

_instrumentation_tx_snapshot() {
  local dir=$1 output=$2 root rel absolute sensitive rc glob skip
  local -a roots=() volatile=()
  mapfile -t roots <"$dir/roots.list"
  (( ${#roots[@]} > 0 )) || return 2
  # Транзакции, начатые до появления списка, читаются как «изменчивых путей нет».
  [[ -f "$dir/volatile.list" ]] && mapfile -t volatile <"$dir/volatile.list"
  sensitive=$(mktemp "$dir/.snapshot-sensitive.XXXXXX") || return 1
  cp -- "$dir/scope.list" "$sensitive" || {
    rm -f -- "$sensitive"
    return 1
  }
  for root in "${roots[@]}"; do
    while IFS= read -r -d '' rel; do
      [[ "$rel" != *$'\n'* ]] || {
        rm -f -- "$sensitive"
        return 78
      }
      # Мусор работающего стенда (логи, debugbar, трассы Playwright) сторожу неотличим
      # от правки агента: файл был другой — значит кто-то менял. А стенд поднят всю
      # транзакцию, потому что узел вроде TRACE ради живого прогона и существует.
      # Сторож может встать на сотнях файлов storage/debugbar без единого исходника.
      # Что мусор, знает только проект — движок берёт список из профиля и молча
      # выбрасывает совпавшее ДО того, как путь попадёт в чувствительное множество.
      skip=0
      for glob in ${volatile[@]+"${volatile[@]}"}; do
        [[ -n "$glob" ]] || continue
        # shellcheck disable=SC2053  # справа именно шаблон, кавычки убили бы смысл
        if [[ "$rel" == $glob ]]; then
          skip=1
          break
        fi
      done
      (( skip == 0 )) || continue
      absolute="$root/$rel"
      [[ -e "$absolute" || -L "$absolute" ]] &&
        printf '%s\n' "$absolute" >>"$sensitive"
    done < <(git -C "$root" ls-files --others --ignored --exclude-standard -z)
  done
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
  _instrumentation_tx_normalize_roots "$tmp/roots.list" "$@" &&
    _instrumentation_tx_normalize_scope "$scope_input" "$tmp/scope.list" "$tmp/roots.list" &&
    _instrumentation_tx_write_volatile "$tmp/volatile.list" &&
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

instrumentation_tx_checkpoint() {
  local task=$1 txid=$2 dir lock_fd state checkpoint next tmp rc
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  state=$(_instrumentation_tx_get "$dir/state.env" STATE)
  [[ "$state" == active ]] || {
    _instrumentation_tx_unlock "$lock_fd"
    return 73
  }
  checkpoint=$(_instrumentation_tx_get "$dir/state.env" CHECKPOINT)
  [[ "$checkpoint" =~ ^[0-9]+$ ]] || checkpoint=0
  next=$((checkpoint + 1))
  tmp="$dir/checkpoint-${next}.tsv"
  if ! _instrumentation_tx_scope_objects_safe "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "unsafe_scope_object"
    _instrumentation_tx_unlock "$lock_fd"
    return 75
  fi
  _instrumentation_tx_snapshot "$dir" "$tmp" || {
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "snapshot_failed"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  if ! workspace_guard_compare_scoped "$dir/baseline.tsv" "$tmp" "$dir/scope.list"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "out_of_scope_change"
    _instrumentation_tx_unlock "$lock_fd"
    return 75
  fi
  cp -- "$tmp" "$dir/.expected.next"
  chmod 600 "$dir/.expected.next"
  mv -f -- "$dir/.expected.next" "$dir/expected.tsv"
  _instrumentation_tx_write_state "$dir" active "$next"
  _instrumentation_tx_unlock "$lock_fd"
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

instrumentation_tx_cleanup() {
  local task=$1 txid=$2 dir root lock_fd state checkpoint current final rc active
  local INSTRUMENTATION_TX_RESTORE_COUNT=0
  root=$(instrumentation_tx_root "$task")
  dir=$(instrumentation_tx_dir "$task" "$txid") || return
  _instrumentation_tx_lock "$task" lock_fd || return
  state=$(_instrumentation_tx_get "$dir/state.env" STATE)
  checkpoint=$(_instrumentation_tx_get "$dir/state.env" CHECKPOINT)
  active="$root/active.env"
  if [[ "$state" == completed ]]; then
    # Crash мог произойти после durable terminal state, но до удаления mutable pointer.
    # Повтор cleanup безопасно завершает только этот остаточный шаг.
    if [[ "$(_instrumentation_tx_get "$active" TRANSACTION_ID)" == "$txid" ]]; then
      rm -f -- "$active"
    fi
    _instrumentation_tx_unlock "$lock_fd"
    return 0
  fi
  [[ ( "$state" == active || "$state" == cleaning ) && -f "$dir/expected.tsv" ]] || {
    _instrumentation_tx_unlock "$lock_fd"
    return 73
  }

  if ! _instrumentation_tx_scope_objects_safe "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "unsafe_scope_object"
    _instrumentation_tx_unlock "$lock_fd"
    return 75
  fi

  current="$dir/cleanup-current.tsv"
  _instrumentation_tx_snapshot "$dir" "$current" || {
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "cleanup_snapshot_failed"
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }

  if [[ "$state" == active ]]; then
    if ! workspace_guard_compare "$dir/expected.tsv" "$current"; then
      _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "concurrent_change"
      _instrumentation_tx_unlock "$lock_fd"
      return 75
    fi
    # Durable cleaning state публикуется до первой операции restore. После SIGKILL
    # повторный cleanup отличает штатную частичную очистку от чужой правки.
    _instrumentation_tx_write_state "$dir" cleaning "$checkpoint" ||
      {
        _instrumentation_tx_unlock "$lock_fd"
        return 1
      }
    _instrumentation_tx_sync_state "$dir" || {
      _instrumentation_tx_unlock "$lock_fd"
      return 1
    }
  else
    _instrumentation_tx_snapshot_is_expected_or_baseline \
      "$dir/expected.tsv" "$dir/baseline.tsv" "$current"
    rc=$?
    if (( rc != 0 )); then
      _instrumentation_tx_write_state "$dir" stalled "$checkpoint" \
        "cleanup_resume_conflict"
      _instrumentation_tx_unlock "$lock_fd"
      return 75
    fi
  fi

  _instrumentation_tx_restore_files "$dir" &&
    _instrumentation_tx_restore_indexes "$dir"
  rc=$?
  if (( rc != 0 )); then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "restore_failed"
    _instrumentation_tx_unlock "$lock_fd"
    return "$rc"
  fi

  final="$dir/cleanup-final.tsv"
  _instrumentation_tx_snapshot "$dir" "$final" || rc=1
  if (( ${rc:-0} != 0 )) ||
     ! workspace_guard_compare "$dir/baseline.tsv" "$final" ||
     ! _instrumentation_tx_marker_absent "$dir" ||
     ! _instrumentation_tx_marker_absent_in_roots "$dir"; then
    _instrumentation_tx_write_state "$dir" stalled "$checkpoint" "baseline_not_restored"
    _instrumentation_tx_unlock "$lock_fd"
    return 75
  fi

  _instrumentation_tx_write_state "$dir" completed "$checkpoint" ||
    {
      _instrumentation_tx_unlock "$lock_fd"
      return 1
    }
  _instrumentation_tx_sync_state "$dir" || {
    _instrumentation_tx_unlock "$lock_fd"
    return 1
  }
  if [[ "$(_instrumentation_tx_get "$active" TRANSACTION_ID)" == "$txid" ]]; then
    rm -f -- "$active"
  fi
  _instrumentation_tx_unlock "$lock_fd"
}
