#!/usr/bin/env bash
# Точный снимок исходных git-деревьев для проверочных этапов.
#
# Старый сторож сравнивал только список уже грязных tracked-файлов. Он не замечал:
# - повторную правку файла, который был грязным до запуска;
# - изменение index;
# - изменение существующего untracked-файла;
# - подмену symlink.
#
# Этот модуль не восстанавливает файлы. Он только доказывает, совпадает ли текущее
# состояние с baseline. Автоматический откат без владения изменением опасен: можно
# перезаписать параллельную работу человека.

workspace_guard_sha256_stream() {
  sha256sum | awk '{print $1}'
}

workspace_guard_b64() {
  base64 -w0
}

workspace_guard_repo_root() {
  local candidate=${1:?candidate}
  [[ -d "$candidate" ]] || return 1
  git -C "$candidate" rev-parse --show-toplevel 2>/dev/null
}

# Записи о файлах пачкой — один процесс python на весь список вместо форков на каждый файл.
#
# Раньше файл стоил 5-6 процессов: git rev-parse на поиск корня, stat на режим, sha256sum на
# содержимое, два base64 на пути, плюс subshell на каждую подстановку. Пока в списке лежала
# горстка untracked-файлов, этого никто не замечал. В приёмочном прогоне t8165 в чувствительный
# список попали ВСЕ игнорируемые git файлы обоих рабочих деревьев — 72 778 путей, 64 файла в
# секунду, 19 минут на один снимок. А снимок берётся четырежды за транзакцию (baseline,
# checkpoint и дважды в cleanup), и всё это время демон держит локи задачи, а на доске висит
# прошлый узел: человек видит вставший конвейер там, где движок считает хеши.
#
# Формат записи не изменился НИ НА БАЙТ и меняться не должен: снимки сравниваются `cmp`, и
# baseline, снятый прошлой версией движка, обязан сойтись с checkpoint новой — иначе перезапуск
# демона посреди открытой транзакции выдаст ложное нарушение readonly и убьёт живой прогон.
# Поэтому sha256, base64 и восьмеричный режим считаются здесь ровно так же, как их считали
# sha256sum, base64 -w0 и stat -c '%a', а редкая ветка «ни файл, ни symlink» по-прежнему зовёт
# stat -c '%F:%s:%Y': его текст переводится локалью, и повторить его в python нельзя.
# Сверка на фикстуре со всеми видами записей дала ровно одно расхождение — и то в пользу
# нового кода: у имени с переводом строки (или обратным слэшем) sha256sum экранирует ВСЮ
# строку вывода ведущим `\`, и прежний `awk '{print $1}'` приклеивал этот слэш к хешу.
# В поле оказывалось 65 символов вместо 64. Сравнение снимков от этого не ломалось (обе
# стороны врали одинаково), но чинить такое молча нельзя — здесь пишется настоящий sha256.
#
# SENSITIVE читает список абсолютных путей построчно и сам ищет корень репозитория;
# UNTRACKED читает NUL-разделённые пути относительно уже известного корня. Ошибка на файле
# для SENSITIVE — пропуск записи (путь мог исчезнуть между проверкой и чтением), для
# UNTRACKED — провал снимка: там список только что выдал сам git.
#
# Список приходит на fd 3, а не на stdin: stdin занят текстом самой программы (heredoc).
_workspace_guard_batch_records() {
  local kind=${1:?kind} root=${2:-}
  python3 - "$kind" "$root" <<'PY'
import base64
import hashlib
import os
import stat
import subprocess
import sys

KIND = sys.argv[1]
ROOT = os.fsencode(sys.argv[2])
STRICT = KIND == "UNTRACKED"
CHUNK = 1 << 20

# GIT_DIR/GIT_WORK_TREE отменяют обычный поиск .git вверх по дереву: если они выставлены,
# ответ знает только сам git, и ускорение по цепочке каталогов применять нельзя.
GIT_ENV = any(os.environ.get(name) for name in ("GIT_DIR", "GIT_WORK_TREE"))
ROOT_CACHE = {}


def b64(raw):
    return base64.b64encode(raw)


def git_toplevel(directory):
    done = subprocess.run(
        [b"git", b"-C", directory, b"rev-parse", b"--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if done.returncode != 0:
        return b""
    return done.stdout.split(b"\n")[0]


def repo_root(directory):
    # git ищет ближайший .git вверх по дереву — тем же обходом мы находим кандидата и зовём
    # git один раз на репозиторий, а не на каждый файл. Ответ всё равно даёт git: он
    # разрешает симлинки в пути, и самодельный ответ разошёлся бы со снимками прошлой версии.
    cached = ROOT_CACHE.get(directory)
    if cached is not None:
        return cached
    if not os.path.isdir(directory):
        ROOT_CACHE[directory] = b""
        return b""
    if GIT_ENV:
        root = git_toplevel(directory)
        ROOT_CACHE[directory] = root
        return root
    chain = []
    probe = directory
    while True:
        cached = ROOT_CACHE.get(probe)
        if cached is not None:
            root = cached
            break
        chain.append(probe)
        if os.path.lexists(os.path.join(probe, b".git")):
            root = git_toplevel(probe)
            break
        parent = os.path.dirname(probe)
        if parent == probe:
            root = b""
            break
        probe = parent
    for item in chain:
        ROOT_CACHE[item] = root
    return root


def file_hash(path):
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            while True:
                block = handle.read(CHUNK)
                if not block:
                    break
                digest.update(block)
    except OSError:
        # Нечитаемый файл — пустое поле хеша, ровно как у прежнего конвейера
        # `sha256sum | awk '{print $1}'`: код возврата брался у awk, поэтому провал
        # sha256sum давал пустую строку и снимок продолжался. Контейнеры стенда пишут
        # в рабочее дерево от своего пользователя, и падать на таком файле нельзя:
        # снимок обвалился бы в snapshot_failed и остановил прогон.
        return b""
    return digest.hexdigest().encode("ascii")


def other_hash(path):
    done = subprocess.run(
        [b"stat", b"-c", b"%F:%s:%Y", b"--", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if done.returncode != 0:
        raise OSError(path)
    # Хешируется вывод stat целиком, вместе с переводом строки: конвейер `stat | sha256sum`
    # хешировал именно его.
    return hashlib.sha256(done.stdout).hexdigest().encode("ascii")


def record(root, rel, path):
    info = os.lstat(path)
    mode = format(stat.S_IMODE(info.st_mode), "o").encode("ascii")
    target = b""
    if stat.S_ISLNK(info.st_mode):
        kind = b"symlink"
        target = os.readlink(path)
        digest = hashlib.sha256(target).hexdigest().encode("ascii")
    elif stat.S_ISREG(info.st_mode):
        kind = b"file"
        digest = file_hash(path)
    else:
        kind = b"other"
        digest = other_hash(path)
    return b"\t".join(
        (KIND.encode("ascii"), b64(root), b64(rel), kind, mode, digest, b64(target))
    ) + b"\n"


with os.fdopen(3, "rb") as source:
    data = source.read()
items = data.split(b"\0" if STRICT else b"\n")
if items and items[-1] == b"":
    items.pop()

out = sys.stdout.buffer
batch = []
for item in items:
    if STRICT:
        root, rel, path = ROOT, item, ROOT + b"/" + item
    else:
        if not item or not item.startswith(b"/") or not os.path.lexists(item):
            continue
        root = repo_root(os.path.dirname(item))
        if root and item.startswith(root + b"/"):
            rel = item[len(root) + 1:]
        else:
            root, rel = b"/", item[1:]
        path = item
    try:
        batch.append(record(root, rel, path))
    except OSError:
        if STRICT:
            sys.exit(1)
        continue
    if len(batch) >= 512:
        out.write(b"".join(batch))
        batch = []
out.write(b"".join(batch))
PY
}

_workspace_guard_sensitive_records() {
  local list_file=${WORKSPACE_GUARD_SENSITIVE_LIST_FILE:-}
  [[ -n "$list_file" && -f "$list_file" ]] || return 0
  _workspace_guard_batch_records SENSITIVE '' 3<"$list_file"
}

# workspace_guard_snapshot <output> <git-root-or-child>...
#
# Формат — детерминированный TSV. Пути и symlink targets кодируются base64, поэтому
# пробелы, табы и переводы строк в именах не ломают сравнение. Содержимое чувствительных
# файлов никогда не попадает в снимок — только hash.
workspace_guard_snapshot() {
  local output=${1:?output}
  shift
  (( $# > 0 )) || return 2

  local output_dir tmp candidate root root64 head worktree_hash index_hash rel
  output_dir=$(dirname "$output")
  mkdir -p "$output_dir"
  tmp=$(mktemp "$output_dir/.workspace-guard.XXXXXX") || return 1

  local roots_file
  roots_file=$(mktemp "$output_dir/.workspace-roots.XXXXXX") || {
    rm -f -- "$tmp"
    return 1
  }
  for candidate in "$@"; do
    root=$(workspace_guard_repo_root "$candidate" 2>/dev/null || true)
    [[ -n "$root" ]] && printf '%s\0' "$root"
  done | sort -zu >"$roots_file"

  if [[ ! -s "$roots_file" ]]; then
    rm -f -- "$tmp" "$roots_file"
    return 2
  fi

  (
    printf 'SCHEMA\t1\n'
    while IFS= read -r -d '' root; do
      root64=$(printf '%s' "$root" | workspace_guard_b64)
      head=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null || printf 'UNBORN')
      worktree_hash=$(
        if [[ "$head" == UNBORN ]]; then
          git -C "$root" diff --binary --no-ext-diff --
        else
          git -C "$root" diff --binary --no-ext-diff HEAD --
        fi | workspace_guard_sha256_stream
      ) || exit 1
      index_hash=$(
        git -C "$root" diff --cached --binary --no-ext-diff -- |
          workspace_guard_sha256_stream
      ) || exit 1
      printf 'ROOT\t%s\n' "$root64"
      printf 'HEAD\t%s\t%s\n' "$root64" "$head"
      printf 'WORKTREE_DIFF\t%s\t%s\n' "$root64" "$worktree_hash"
      printf 'INDEX_DIFF\t%s\t%s\n' "$root64" "$index_hash"

      if [[ "$head" != UNBORN ]]; then
        while IFS= read -r -d '' rel; do
          local path_hash path64
          path64=$(printf '%s' "$rel" | workspace_guard_b64)
          path_hash=$(
            git -C "$root" diff --binary --no-ext-diff --no-renames HEAD -- "$rel" |
              workspace_guard_sha256_stream
          ) || exit 1
          printf 'TRACKED_WORKTREE\t%s\t%s\t%s\n' "$root64" "$path64" "$path_hash"
        done < <(git -C "$root" diff --name-only -z --no-ext-diff --no-renames HEAD -- | sort -z)
      fi

      while IFS= read -r -d '' rel; do
        local path_hash path64
        path64=$(printf '%s' "$rel" | workspace_guard_b64)
        path_hash=$(
          git -C "$root" diff --cached --binary --no-ext-diff --no-renames -- "$rel" |
            workspace_guard_sha256_stream
        ) || exit 1
        printf 'TRACKED_INDEX\t%s\t%s\t%s\n' "$root64" "$path64" "$path_hash"
      done < <(git -C "$root" diff --cached --name-only -z --no-ext-diff --no-renames -- | sort -z)

      _workspace_guard_batch_records UNTRACKED "$root" \
        3< <(git -C "$root" ls-files --others --exclude-standard -z | sort -z) || exit 1
    done <"$roots_file"

    _workspace_guard_sensitive_records
  ) >"$tmp"
  local rc=$?
  rm -f -- "$roots_file"
  if (( rc != 0 )); then
    rm -f -- "$tmp"
    return "$rc"
  fi

  chmod 600 "$tmp"
  mv -f -- "$tmp" "$output"
}

workspace_guard_compare() {
  local before=${1:?before} after=${2:?after}
  [[ -f "$before" && -f "$after" ]] || return 2
  cmp -s -- "$before" "$after"
}

# Безопасная сводка различий: только тип записи, base64-путь и hashes.
# Содержимое diff и чувствительных файлов не выводится.
workspace_guard_diff_summary() {
  local before=${1:?before} after=${2:?after}
  [[ -f "$before" && -f "$after" ]] || return 2
  diff -u -- "$before" "$after" |
    awk '/^[+-](ROOT|HEAD|WORKTREE_DIFF|INDEX_DIFF|TRACKED_WORKTREE|TRACKED_INDEX|UNTRACKED|SENSITIVE)\t/ { print }'
}

# То же самое, но человеку: тип записи и РАСКОДИРОВАННЫЙ путь, сгруппированные по
# каталогу и с числом файлов. Хеши и содержимое не выводятся — раскрывается ровно то,
# что и так видно в `git status`. Нужно журналу: fail-closed писал одну строку «код 75»,
# и чтобы понять, из-за чего встала приёмка t8165, приходилось руками разбирать base64
# в снимках транзакции. Сводка ограничена сверху: расхождений бывают тысячи.
workspace_guard_diff_paths() {
  local before=${1:?before} after=${2:?after} limit=${3:-12}
  [[ -f "$before" && -f "$after" ]] || return 2
  [[ "$limit" =~ ^[0-9]+$ ]] || return 2
  # Сводка приходит на fd 3, как и список путей в _workspace_guard_batch_records:
  # stdin занят текстом самой программы (heredoc), и обычный конвейер сюда не годится —
  # питон прочитал бы с него собственный исходник, а не расхождения.
  python3 - "$limit" <<'PY' 3< <(workspace_guard_diff_summary "$before" "$after")
import base64, collections, os, sys

LIMIT = int(sys.argv[1])
groups = collections.Counter()
for line in os.fdopen(3, "rb"):
    line = line.rstrip(b"\n")
    if not line[:1] in (b"+", b"-"):
        continue
    parts = line[1:].split(b"\t")
    if len(parts) < 3:
        continue
    kind = parts[0].decode("ascii", "replace")
    try:
        root = base64.b64decode(parts[1], validate=True)
        rel = base64.b64decode(parts[2], validate=True)
    except Exception:
        continue
    path = os.path.join(os.fsdecode(root), os.fsdecode(rel))
    groups[(kind, os.path.dirname(path))] += 1

for (kind, directory), count in groups.most_common(LIMIT):
    print(f"{kind} {directory} ({count})")
hidden = len(groups) - LIMIT
if hidden > 0:
    print(f"и ещё каталогов: {hidden}")
PY
}

# Сравнивает два снимка, игнорируя изменения только перечисленных absolute paths.
# Aggregate hashes намеренно исключаются: их заменяют per-path TRACKED_* записи.
workspace_guard_compare_scoped() {
  local before=${1:?before} after=${2:?after} scope_file=${3:?scope file}
  [[ -f "$before" && -f "$after" && -f "$scope_file" ]] || return 2
  local dir allowed filtered_before filtered_after absolute root rel root64 path64
  dir=$(dirname "$before")
  allowed=$(mktemp "$dir/.workspace-allowed.XXXXXX") || return 1
  filtered_before=$(mktemp "$dir/.workspace-before.XXXXXX") || {
    rm -f -- "$allowed"
    return 1
  }
  filtered_after=$(mktemp "$dir/.workspace-after.XXXXXX") || {
    rm -f -- "$allowed" "$filtered_before"
    return 1
  }

  while IFS= read -r absolute || [[ -n "$absolute" ]]; do
    [[ -n "$absolute" && "$absolute" == /* ]] || continue
    root=$(workspace_guard_repo_root "$(dirname "$absolute")" 2>/dev/null || true)
    [[ -n "$root" && "$absolute" == "$root/"* ]] || continue
    rel=${absolute#"$root/"}
    root64=$(printf '%s' "$root" | workspace_guard_b64)
    path64=$(printf '%s' "$rel" | workspace_guard_b64)
    printf '%s\t%s\n' "$root64" "$path64"
  done <"$scope_file" | sort -u >"$allowed"

  awk -F'\t' -v allowed_file="$allowed" '
    BEGIN {
      while ((getline line < allowed_file) > 0) allowed[line] = 1
      close(allowed_file)
    }
    $1 == "WORKTREE_DIFF" || $1 == "INDEX_DIFF" { next }
    $1 == "TRACKED_WORKTREE" || $1 == "TRACKED_INDEX" ||
    $1 == "UNTRACKED" || $1 == "SENSITIVE" {
      if (($2 "\t" $3) in allowed) next
    }
    { print }
  ' "$before" >"$filtered_before"
  awk -F'\t' -v allowed_file="$allowed" '
    BEGIN {
      while ((getline line < allowed_file) > 0) allowed[line] = 1
      close(allowed_file)
    }
    $1 == "WORKTREE_DIFF" || $1 == "INDEX_DIFF" { next }
    $1 == "TRACKED_WORKTREE" || $1 == "TRACKED_INDEX" ||
    $1 == "UNTRACKED" || $1 == "SENSITIVE" {
      if (($2 "\t" $3) in allowed) next
    }
    { print }
  ' "$after" >"$filtered_after"

  cmp -s -- "$filtered_before" "$filtered_after"
  local rc=$?
  rm -f -- "$allowed" "$filtered_before" "$filtered_after"
  return "$rc"
}
