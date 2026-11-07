#!/usr/bin/env python3
"""Атомарно заменяет один файл приватного состояния через унаследованный дескриптор каталога."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
import sys
from typing import Any, Dict, Optional, Tuple


DIRECTORY_FD = 3
MAX_REQUEST_BYTES = 32 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,240}$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")


class SafeFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def answer(status: str, **values: Any) -> None:
    data = json.dumps(
        {"status": status, **values},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    sys.stdout.buffer.write(data + b"\n")
    sys.stdout.buffer.flush()


def name(value: Any) -> str:
    if not isinstance(value, str) or not NAME_RE.fullmatch(value) or value in (".", ".."):
        raise SafeFailure("invalid_name")
    return value


def uint(value: Any) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise SafeFailure("invalid_fingerprint")
    return int(value)


def sha(value: Any, *, nullable: bool = False) -> Optional[str]:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise SafeFailure("invalid_hash")
    return value


def fingerprint(raw: Any) -> Dict[str, int]:
    if not isinstance(raw, dict):
        raise SafeFailure("invalid_fingerprint")
    return {
        "dev": uint(raw.get("dev")),
        "ino": uint(raw.get("ino")),
        "size": uint(raw.get("size")),
        "mtimeNs": uint(raw.get("mtimeNs")),
        "mode": uint(raw.get("mode")),
        "nlink": uint(raw.get("nlink")),
    }


def same_identity(value: os.stat_result, expected: Dict[str, int]) -> bool:
    return (
        value.st_dev == expected["dev"]
        and value.st_ino == expected["ino"]
        and value.st_size == expected["size"]
        and value.st_mtime_ns == expected["mtimeNs"]
        and stat.S_IMODE(value.st_mode) == expected["mode"]
        and value.st_nlink == expected["nlink"]
    )


def same_snapshot(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
        and left.st_ctime_ns == right.st_ctime_ns
        and left.st_mode == right.st_mode
        and left.st_nlink == right.st_nlink
    )


def read_hash(descriptor: int, limit: int) -> Tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(descriptor, min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise SafeFailure("too_large")
        digest.update(chunk)
        if total == limit:
            if os.read(descriptor, 1):
                raise SafeFailure("too_large")
            break
    return digest.hexdigest(), total


def open_verified_source(
    source: str,
    expected: Dict[str, int],
    expected_hash: str,
    limit: int,
) -> Tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(source, flags, dir_fd=DIRECTORY_FD)
    except FileNotFoundError as exc:
        raise SafeFailure("source_missing") from exc
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise SafeFailure("unsafe_source") from exc
        raise SafeFailure("io_failure") from exc
    try:
        before = os.fstat(descriptor)
        named_before = os.stat(source, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        if (
            not stat.S_ISREG(before.st_mode)
            or not stat.S_ISREG(named_before.st_mode)
            or before.st_dev != named_before.st_dev
            or before.st_ino != named_before.st_ino
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or not same_identity(before, expected)
        ):
            raise SafeFailure("source_changed")
        actual_hash, total = read_hash(descriptor, limit)
        after = os.fstat(descriptor)
        named_after = os.stat(source, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        if (
            total != before.st_size
            or actual_hash != expected_hash
            or not same_snapshot(before, after)
            or not same_snapshot(after, named_after)
        ):
            raise SafeFailure("source_changed")
        return descriptor, after
    except Exception:
        os.close(descriptor)
        raise


def current_target_hash(target: str, limit: int) -> Optional[str]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(target, flags, dir_fd=DIRECTORY_FD)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise SafeFailure("unsafe_target") from exc
        raise SafeFailure("io_failure") from exc
    try:
        before = os.fstat(descriptor)
        named_before = os.stat(target, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        if (
            not stat.S_ISREG(before.st_mode)
            or not stat.S_ISREG(named_before.st_mode)
            or before.st_dev != named_before.st_dev
            or before.st_ino != named_before.st_ino
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
        ):
            raise SafeFailure("unsafe_target")
        actual_hash, total = read_hash(descriptor, limit)
        after = os.fstat(descriptor)
        named_after = os.stat(target, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        if total != before.st_size or not same_snapshot(before, after) or not same_snapshot(after, named_after):
            raise SafeFailure("target_changed")
        return actual_hash
    finally:
        os.close(descriptor)


def main() -> None:
    directory = os.fstat(DIRECTORY_FD)
    if not stat.S_ISDIR(directory.st_mode) or stat.S_IMODE(directory.st_mode) != 0o700:
        raise SafeFailure("unsafe_directory")
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise SafeFailure("request_too_large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SafeFailure("invalid_request") from exc
    if not isinstance(request, dict) or request.get("operation") != "replace":
        raise SafeFailure("invalid_request")
    source = name(request.get("source"))
    target = name(request.get("target"))
    expected_source = fingerprint(request.get("fingerprint"))
    expected_source_hash = sha(request.get("sha256"))
    expected_target_hash = sha(request.get("expectedTargetSha256"), nullable=True)
    limit = request.get("maxBytes")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0 or limit > 2**31:
        raise SafeFailure("invalid_limit")

    source_fd, source_stat = open_verified_source(
        source, expected_source, expected_source_hash, limit
    )
    try:
        observed_target_hash = current_target_hash(target, limit)
        if observed_target_hash != expected_target_hash:
            raise SafeFailure("target_conflict")
        try:
            os.replace(
                source,
                target,
                src_dir_fd=DIRECTORY_FD,
                dst_dir_fd=DIRECTORY_FD,
            )
        except OSError as exc:
            raise SafeFailure("io_failure") from exc
        target_after = os.stat(target, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        source_after = os.fstat(source_fd)
        if (
            target_after.st_dev != source_stat.st_dev
            or target_after.st_ino != source_stat.st_ino
            or source_after.st_dev != source_stat.st_dev
            or source_after.st_ino != source_stat.st_ino
            or target_after.st_nlink != 1
            or not stat.S_ISREG(target_after.st_mode)
            or stat.S_IMODE(target_after.st_mode) != 0o600
        ):
            raise SafeFailure("replace_uncertain")
        answer("replaced")
    finally:
        os.close(source_fd)


if __name__ == "__main__":
    try:
        main()
    except SafeFailure as failure:
        answer("error", code=failure.code)
    except Exception:
        answer("error", code="helper_failure")
