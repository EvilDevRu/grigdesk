#!/usr/bin/env python3
"""Изолированные Git probes для proof снимка рабочего дерева на Darwin."""

from __future__ import annotations

import base64
import ctypes
import errno
import hashlib
import json
import mmap
import os
import re
import shutil
import stat
import subprocess
import struct
import sys
import tempfile
from pathlib import Path


SAFE_CONFIG = {
    "core.abbrev", "core.autocrlf", "core.safecrlf", "core.eol", "core.filemode",
    "core.symlinks", "core.ignorecase", "core.precomposeunicode", "core.checkstat",
    "core.trustctime", "core.ignorestat", "core.sparsecheckout", "core.sparsecheckoutcone",
    "index.sparse", "diff.algorithm", "diff.renames", "diff.indentheuristic",
    "diff.context", "diff.mnemonicprefix", "diff.noprefix", "diff.srcprefix", "diff.dstprefix",
}
ENTRY = re.compile(rb"(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)", re.S)
ENTRY_DEBUG = re.compile(
    rb"  ctime: [0-9]+:[0-9]+\n  mtime: [0-9]+:[0-9]+\n"
    rb"  dev: [0-9]+\tino: [0-9]+\n  uid: [0-9]+\tgid: [0-9]+\n"
    rb"  size: [0-9]+\tflags: ([0-9a-f]{1,8})\n",
)
SEMANTIC_FLAGS = 0x00008000 | (1 << 29) | (1 << 30)
RENAME_EXCL = 0x00000004


def git_environment() -> dict[str, str]:
    """Git получает собственную конфигурацию, без унаследованных выбранных путей."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    return env


def git_query(root: str, *args: str, absent: int | None = None) -> bytes | None:
    """Проверяет status read-only команды; только явное отсутствие допускает пустой результат."""
    result = subprocess.run(
        ["git", "-C", root, *args], env=git_environment(), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, timeout=30, check=False,
    )
    if result.returncode == absent:
        return None
    result.check_returncode()
    return result.stdout


def physical_path(value: bytes) -> str:
    """Git сообщает абсолютный адрес; никакая компонента не меняет реальный корень."""
    path = os.fsdecode(value.removesuffix(b"\n"))
    if not os.path.isabs(path) or os.path.realpath(path) != path or any(c in path for c in "\n\r\t"):
        raise ValueError("нефизический путь Git")
    return path


def evidence(info: os.stat_result) -> list[int]:
    return [info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def capture_index(source: str, target: Path | None = None, *, durable: bool = False) -> dict | None:
    """Читает pinned index с одним FD и сохраняет его положение для racy-clean."""
    try:
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise ValueError("index не принадлежит владельцу Git")
        original = evidence(info)
        digest = hashlib.sha256()
        output = target.open("xb") if target is not None else None
        try:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                if output is not None:
                    output.write(chunk)
            if output is not None:
                output.flush()
                os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode) & 0o700)
                os.utime(output.fileno(), ns=(info.st_atime_ns, info.st_mtime_ns))
                if os.fstat(output.fileno()).st_mtime_ns != info.st_mtime_ns:
                    raise ValueError("mtime копии index отличается")
                if durable:
                    os.fsync(output.fileno())
        finally:
            if output is not None:
                output.close()
        if evidence(os.fstat(fd)) != original or evidence(os.lstat(source)) != original:
            raise ValueError("index изменился при чтении")
        return {"stat": original, "sha256": digest.hexdigest()}


def head_value(root: str) -> str | None:
    """Пустой результат имеет место только у unborn HEAD."""
    head = git_query(root, "rev-parse", "--verify", "--quiet", "HEAD", absent=1)
    if head is None:
        git_query(root, "symbolic-ref", "--quiet", "HEAD")
        return None
    value = head.decode("ascii").strip()
    if re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", value) is None:
        raise ValueError("некорректный HEAD")
    return value


def git_location(root: str, *args: str) -> str:
    result = git_query(root, "rev-parse", "--path-format=absolute", *args)
    return physical_path(result)


def safe_config(root: str) -> list[tuple[str, str]]:
    """Копирует эффективные параметры сравнения, исключая hooks и команды драйверов."""
    output = git_query(root, "config", "--null", "--list", "--includes")
    values: list[tuple[str, str]] = []
    for line in output.split(b"\0")[:-1]:
        key_raw, _, value_raw = line.partition(b"\n")
        key = os.fsdecode(key_raw)
        value = os.fsdecode(value_raw or b"true")
        if key in SAFE_CONFIG or re.fullmatch(r"diff\.[^.]+\.(binary|xfuncname|funcname)", key):
            values.append((key, value))
    return values


def copy_optional(source: Path, dest: Path) -> None:
    """Копирует только данные атрибутов и исключений в одно служебное имя."""
    try:
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NONBLOCK), "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError("Git attrs/ignore не является файлом")
            with dest.open("xb") as output:
                shutil.copyfileobj(handle, output)
    except FileNotFoundError:
        return


def split_index_oid(copy: Path, object_format: str) -> str | None:
    """Читает link extension копии DIRC без Git, который освежает real sharedindex."""
    hash_size = hashlib.new(object_format).digest_size
    with copy.open("rb") as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        if len(data) < 12 + hash_size:
            raise ValueError("обрезанный Git index")
        signature, version, count = struct.unpack_from(">4sII", data, 0)
        if signature != b"DIRC" or version not in {2, 3, 4}:
            raise ValueError("неподдерживаемый формат Git index")
        ceiling = len(data) - hash_size
        offset = 12
        for _ in range(count):
            start = offset
            flags_offset = offset + 40 + hash_size
            if flags_offset + 2 > ceiling:
                raise ValueError("обрезанная entry Git index")
            flags, = struct.unpack_from(">H", data, flags_offset)
            offset = flags_offset + (4 if flags & 0x4000 else 2)
            if version == 4:
                for _ in range(10):
                    if offset >= ceiling:
                        raise ValueError("обрезанный prefix Git index")
                    octet = data[offset]
                    offset += 1
                    if not octet & 0x80:
                        break
                else:
                    raise ValueError("неподдерживаемый prefix Git index")
            end = data.find(b"\0", offset, ceiling)
            if end < 0:
                raise ValueError("обрезанный путь Git index")
            offset = end + 1 if version == 4 else start + ((end + 1 - start + 7) & ~7)
        result = None
        found_link = False
        while offset < ceiling:
            if offset + 8 > ceiling:
                raise ValueError("обрезанное расширение Git index")
            kind, length = struct.unpack_from(">4sI", data, offset)
            offset += 8
            if offset + length > ceiling:
                raise ValueError("неверная длина расширения index")
            if kind == b"link":
                if found_link or length < hash_size:
                    raise ValueError("неоднозначная split-index база")
                found_link = True
                value = data[offset : offset + hash_size]
                if any(value):
                    result = value.hex()
            offset += length
        if offset != ceiling:
            raise ValueError("неизвестный конец Git index")
        return result


def capture_repository_indexes(root: str, destination: Path, *, durable: bool = False) -> tuple[str, dict]:
    """Один формат доказательства для изолированного probe и durable TX baseline."""
    index = git_location(root, "--git-path", "index")
    object_format = git_query(root, "rev-parse", "--show-object-format").decode("ascii").strip()
    copy = destination / "index"
    files = {index: capture_index(index, copy, durable=durable)}
    shared = None if files[index] is None else split_index_oid(copy, object_format)
    if shared is not None:
        name = f"sharedindex.{shared}"
        source = str(Path(git_location(root, "--absolute-git-dir")) / name)
        if os.path.realpath(source) != source:
            raise ValueError("нефизическая split-index база")
        files[source] = capture_index(source, destination / name, durable=durable)
        if files[source] is None:
            raise ValueError("split index отсутствует")
    if any(capture_index(source) != proof for source, proof in files.items()):
        raise ValueError("index изменился после захвата")
    return index, files


def sync_directory(path: Path) -> None:
    """Синхронизирует физическое имя файлов и публикации на том же томе."""
    fd = os.open(path, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rename_exclusive(fd: int, source: str, target: str) -> None:
    """Публикует новое имя на том же томе и сохраняет данные прежнего владельца."""
    rename = ctypes.CDLL(None, use_errno=True).renameatx_np
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(fd, os.fsencode(source), fd, os.fsencode(target), RENAME_EXCL) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def publish_immutable(directory: Path, name: str, data: bytes, *, mode: int = 0o600) -> None:
    """Повтор с теми же байтами заново синхронизирует уже опубликованную запись."""
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd, raw = tempfile.mkstemp(prefix=".checkpoint.", dir=directory)
    temporary = Path(raw)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        try:
            rename_exclusive(parent, temporary.name, name)
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(existing, "rb") as source:
                info = os.fstat(existing)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() \
                        or stat.S_IMODE(info.st_mode) != mode or source.read(len(data) + 1) != data:
                    raise ValueError("неизменяемый checkpoint имеет другие байты")
                os.fsync(existing)
        os.fsync(parent)
    finally:
        os.close(parent)
        temporary.unlink(missing_ok=True)


def backup_indexes(transaction: Path) -> None:
    """Закрепляет exact метаданные native index и независимые байты split base."""
    roots = (transaction / "roots.list").read_text(encoding="utf-8").splitlines()
    indexes = transaction / "indexes"
    indexes.mkdir(mode=0o700)
    repositories = []
    lines = []
    for root in roots:
        identity = hashlib.sha256(os.fsencode(root)).hexdigest()
        directory = indexes / identity
        directory.mkdir(mode=0o700)
        index, files = capture_repository_indexes(root, directory, durable=True)
        record = files[index]
        root_encoded = base64.b64encode(os.fsencode(root)).decode("ascii")
        if record is None:
            lines.append([root_encoded, index, "0", "-", "-", "-"])
        else:
            mode = format(stat.S_IMODE(record["stat"][3]), "o")
            lines.append([root_encoded, index, "1", mode, record["sha256"], f"indexes/{identity}/index"])
        observed, entries = capture_logical_entries(root)
        if files != observed:
            raise ValueError("baseline index изменился между снимками")
        repositories.append({
            "root": root, "index": index, "backup": identity, "files": files,
            "outsideScope": outside_scope_digest(entries, root, transaction),
        })
        sync_directory(directory)
    if not repositories:
        raise ValueError("в TX отсутствуют Git roots")
    with (transaction / "indexes.tsv").open("x", encoding="utf-8") as listing:
        listing.write("".join("\t".join(line) + "\n" for line in lines))
        listing.flush()
        os.fsync(listing.fileno())
    manifest = transaction / "indexes.darwin.json"
    with manifest.open("x", encoding="utf-8") as output:
        json.dump({"format": 1, "repositories": repositories}, output, ensure_ascii=True)
        output.flush()
        os.fchmod(output.fileno(), 0o400)
        os.fsync(output.fileno())
    sync_directory(indexes)
    sync_directory(transaction)


def prepare(scratch: Path, root: str) -> None:
    """Закрепляет физическое дерево Git, index/split base и конфигурацию чтения."""
    if not os.path.isabs(root) or os.path.realpath(root) != root:
        raise ValueError("нефизический корень рабочего дерева")
    git_dir = git_location(root, "--absolute-git-dir")
    common = git_location(root, "--git-common-dir")
    objects = git_location(root, "--git-path", "objects")
    if any(scratch.is_relative_to(base) for base in (root, git_dir, common)):
        raise ValueError("scratch пересекается с настоящим репозиторием")
    object_format = git_query(root, "rev-parse", "--show-object-format").decode("ascii").strip()
    if object_format not in {"sha1", "sha256"}:
        raise ValueError("неподдерживаемый object format")
    head = head_value(root)
    _, files = capture_repository_indexes(root, scratch)
    defaults = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "git"
    extras = {
        "attributes": Path(common, "info", "attributes"),
        "exclude": Path(common, "info", "exclude"),
        "sparse-checkout": Path(git_dir, "info", "sparse-checkout"),
    }
    for key, name in (("core.attributesfile", "attributes"), ("core.excludesfile", "ignore")):
        configured = git_query(root, "config", "--path", "--get", key, absent=1)
        source = Path(os.fsdecode(configured.removesuffix(b"\n"))) if configured else defaults / name
        extras[f"user-{name}"] = source if source.is_absolute() else Path(root, source)
    for name, source in extras.items():
        copy_optional(source, scratch / name)
    manifest = {
        "root": root, "head": head, "format": object_format, "objects": objects,
        "config": safe_config(root), "files": files,
    }
    (scratch / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def probe(scratch: Path, manifest: dict, command: list[str], *, output=None, semantic: bool = False) -> int:
    """Каждая команда получает свежие копии index и split base тем же mtime."""
    with tempfile.TemporaryDirectory(prefix="probe.", dir=scratch) as working:
        directory = Path(working)
        env = git_environment()
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
        subprocess.run(
            ["git", "init", "--quiet", "--bare", "--template=", f"--object-format={manifest['format']}", working],
            env=env, check=True, timeout=15,
        )
        if manifest["head"] is not None:
            (directory / "HEAD").write_text(manifest["head"] + "\n", encoding="ascii")
        (directory / "info").mkdir(exist_ok=True)
        (directory / "objects" / "info").mkdir(exist_ok=True)
        (directory / "objects" / "info" / "alternates").write_bytes(os.fsencode(manifest["objects"]) + b"\n")
        for source, proof in manifest["files"].items():
            if proof is None:
                continue
            name = Path(source).name
            original = capture_index(str(scratch / name), directory / name)
            if original is None or original["sha256"] != proof["sha256"] or original["stat"][-2] != proof["stat"][-2]:
                raise ValueError("образ index в scratch изменился")
        for name in ("attributes", "exclude", "sparse-checkout"):
            copy_optional(scratch / name, directory / "info" / name)
        values = manifest["config"] + [
            ["core.attributesFile", str(scratch / "user-attributes")],
            ["core.excludesFile", str(scratch / "user-ignore")],
        ]
        flags = [value for key, val in values for value in ("-c", f"{key}={val}")]
        worktree = manifest["root"]
        if semantic:
            worktree = str(directory / "empty-worktree")
            Path(worktree).mkdir(mode=0o700)
            flags.extend(("-c", "core.sparseCheckout=false"))
        env.update(
            GIT_COMMON_DIR=working,
            GIT_INDEX_FILE=str(directory / "index"),
        )
        result = subprocess.run(
            ["git", "-C", worktree, f"--git-dir={working}", f"--work-tree={worktree}",
             *flags, *command],
            env=env, check=False, timeout=60, stdout=output,
        )
        if command[0] == "grep" and result.returncode == 1:
            return 1
        result.check_returncode()
        return 0


def verify_snapshot(manifest: dict) -> None:
    """Расхождение реального index, HEAD или эффективной конфигурации отменяет proof."""
    root = manifest["root"]
    current_config = [list(pair) for pair in safe_config(root)]
    if manifest["head"] != head_value(root) or manifest["config"] != current_config or any(
        capture_index(source) != proof for source, proof in manifest["files"].items()
    ):
        raise ValueError("Git изменил HEAD, index или конфигурацию во время снимка")


def decode_index_entries(stream) -> list[tuple[bytes, bytes, bytes, bytes, int]]:
    """Закрытый decoder Git ls-files --stage --debug -z с точными ключами path/stage."""
    limit = 128 * 1024 * 1024
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("список Git index превышает предел proof")
    offset = 0
    entries = []
    seen = set()
    while offset < len(data):
        nul = data.find(b"\0", offset)
        entry = ENTRY.fullmatch(data[offset:nul]) if nul >= 0 else None
        details = ENTRY_DEBUG.match(data, nul + 1) if nul >= 0 else None
        if not entry or not details:
            raise ValueError("неизвестный формат Git ls-files")
        mode, blob, stage, name = entry.groups()
        key = (name, stage)
        if name.startswith(b"/") or any(piece in {b"", b".", b".."} for piece in name.split(b"/")) or key in seen:
            raise ValueError("неоднозначный path/stage Git index")
        seen.add(key)
        entries.append((name, stage, mode, blob, int(details[1], 16) & SEMANTIC_FLAGS))
        offset = details.end()
    return sorted(entries)


def capture_logical_entries(root: str) -> tuple[dict, list]:
    """Раскрывает sparse по закреплённым objects с пустым worktree и свежим index."""
    with tempfile.TemporaryDirectory(prefix="index-flags.", dir="/private/tmp") as directory:
        isolated = Path(directory)
        prepare(isolated, root)
        manifest = json.loads((isolated / "manifest.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryFile(dir=isolated) as stream:
            probe(isolated, manifest, ["ls-files", "--stage", "--debug", "-z"], output=stream, semantic=True)
            stream.seek(0)
            entries = decode_index_entries(stream)
        verify_snapshot(manifest)
        return manifest["files"], entries


def outside_scope_digest(entries: list, root: str, transaction: Path) -> str:
    """Сравнивает blob/mode/stage и семантические флаги отдельно от stat cache."""
    scope = set((transaction / "scope.list").read_bytes().splitlines())
    prefix = os.fsencode(root) + b"/"
    digest = hashlib.sha256()
    for name, stage, mode, blob, flags in entries:
        if prefix + name in scope:
            continue
        digest.update(b"\0".join((name, stage, mode, blob, str(flags).encode("ascii"))) + b"\0")
    return digest.hexdigest()


def checkpoint_index_evidence(transaction: Path, checkpoint: str, workspace_bytes: bytes) -> dict:
    """Запрещает checkpoint чужого изменения index за пределами точного scope."""
    manifest = transaction / "indexes.darwin.json"
    with os.fdopen(os.open(manifest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r", encoding="utf-8") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o400 or info.st_size > 1024 * 1024
        ):
            raise ValueError("невалидный baseline index")
        value = json.load(file)
    if not isinstance(value, dict) or value.get("format") != 1 or not value.get("repositories"):
        raise ValueError("неизвестный формат baseline index")
    if re.fullmatch(r"[1-9][0-9]{0,17}", checkpoint) is None:
        raise ValueError("невалидное поколение index checkpoint")
    expected = {}
    for repository in value["repositories"]:
        root = repository["root"]
        files, entries = capture_logical_entries(root)
        if outside_scope_digest(entries, root, transaction) != repository["outsideScope"]:
            raise ValueError("Git index изменён за пределами scope")
        expected[root] = files
    return {
        "format": 1, "checkpoint": checkpoint, "repositories": expected,
        "workspaceSHA256": hashlib.sha256(workspace_bytes).hexdigest(),
    }


def verify_checkpoint_indexes(transaction: Path, checkpoint: str, workspace: str) -> None:
    """Контракт низкоуровневой проверки Git; release вызывает writer операции."""
    candidate = Path(workspace)
    if candidate.parent != transaction or candidate.is_symlink() or not candidate.is_file():
        raise ValueError("snapshot рабочего дерева вне TX")
    workspace_bytes = candidate.read_bytes()
    output = checkpoint_index_evidence(transaction, checkpoint, workspace_bytes)
    publish_immutable(transaction, f"checkpoint-{checkpoint}.tsv", workspace_bytes)
    publish_immutable(transaction, f"indexes-expected-{checkpoint}.json",
                      json.dumps(output, ensure_ascii=True, sort_keys=True).encode("utf-8"))


def main() -> int:
    """Подготавливает snapshot, выполняет один probe или проверяет его исходный Git."""
    action, raw_scratch, *args = sys.argv[1:]
    scratch = Path(raw_scratch)
    if scratch.resolve(strict=True) != scratch or not scratch.is_dir() or scratch.stat().st_mode & 0o077:
        raise ValueError("scratch Git недоступен")
    if action == "prepare" and len(args) == 1:
        prepare(scratch, args[0])
        return 0
    if action == "backup-indexes" and not args:
        backup_indexes(scratch)
        return 0
    if action == "verify-checkpoint-indexes" and len(args) == 2:
        verify_checkpoint_indexes(scratch, args[0], args[1])
        return 0
    manifest = json.loads((scratch / "manifest.json").read_text(encoding="utf-8"))
    if action == "probe" and args[0] in {"diff", "ls-files", "grep"}:
        return probe(scratch, manifest, args)
    elif action == "head" and not args:
        print(manifest["head"] or "UNBORN")
    elif action == "verify" and not args:
        verify_snapshot(manifest)
    else:
        raise ValueError("неизвестная операция Git snapshot")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        print("workspace guard: невозможно подтвердить снимок Git Darwin", file=sys.stderr)
        sys.exit(78)
