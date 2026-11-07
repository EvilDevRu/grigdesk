#!/usr/bin/env python3
"""Минимальные Linux dirfd-операции для durable analytics state.

Node.js не экспортирует linkat/unlinkat. Родитель передаёт уже проверенный descriptor
каталога как fd 3, а запрос — одним ограниченным JSON в stdin. Helper никогда не
принимает абсолютный путь и не возвращает filesystem path в ошибке.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
import sys
from typing import Any, Dict, Tuple


DIRECTORY_FD = 3
MAX_REQUEST_BYTES = 32 * 1024
MAX_RESPONSE_BYTES = 8 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,240}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


class SafeFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _answer(status: str, **values: Any) -> None:
    encoded = json.dumps(
        {"status": status, **values},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
    if len(encoded) > MAX_RESPONSE_BYTES:
        encoded = b'{"status":"error","code":"helper_response_too_large"}'
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def _name(value: Any) -> str:
    if not isinstance(value, str) or not NAME_RE.fullmatch(value) or value in (".", ".."):
        raise SafeFailure("invalid_name")
    return value


def _uint(value: Any, code: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise SafeFailure(code)
    return int(value)


def _limit(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2**31:
        raise SafeFailure("invalid_limit")
    return value


def _sha(value: Any) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise SafeFailure("invalid_hash")
    return value


def _fingerprint(raw: Any) -> Dict[str, int]:
    if not isinstance(raw, dict):
        raise SafeFailure("invalid_fingerprint")
    result = {
        "dev": _uint(raw.get("dev"), "invalid_fingerprint"),
        "ino": _uint(raw.get("ino"), "invalid_fingerprint"),
        "size": _uint(raw.get("size"), "invalid_fingerprint"),
        "mtimeNs": _uint(raw.get("mtimeNs"), "invalid_fingerprint"),
    }
    if "mode" in raw:
        result["mode"] = _uint(raw.get("mode"), "invalid_fingerprint")
    if "nlink" in raw:
        result["nlink"] = _uint(raw.get("nlink"), "invalid_fingerprint")
    return result


def _stat_fingerprint(value: os.stat_result) -> Dict[str, int]:
    return {
        "dev": value.st_dev,
        "ino": value.st_ino,
        "size": value.st_size,
        "mtimeNs": value.st_mtime_ns,
        "mode": stat.S_IMODE(value.st_mode),
        "nlink": value.st_nlink,
    }


def _identity_matches(value: os.stat_result, expected: Dict[str, int], *, include_nlink: bool) -> bool:
    actual = _stat_fingerprint(value)
    keys = ("dev", "ino", "size", "mtimeNs", "mode")
    if any(key in expected and actual[key] != expected[key] for key in keys):
        return False
    return not include_nlink or "nlink" not in expected or actual["nlink"] == expected["nlink"]


def _same_snapshot(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
        and left.st_ctime_ns == right.st_ctime_ns
        and left.st_mode == right.st_mode
        and left.st_nlink == right.st_nlink
    )


def _read_verified(
    name: str,
    expected: Dict[str, int],
    expected_sha256: str,
    max_bytes: int,
    required_mode: int | None,
) -> Tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=DIRECTORY_FD)
    except FileNotFoundError as exc:
        raise SafeFailure("missing") from exc
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENXIO, errno.ENODEV):
            raise SafeFailure("unsafe_file") from exc
        raise SafeFailure("io_failure") from exc

    try:
        before = os.fstat(descriptor)
        try:
            named_before = os.stat(name, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        except FileNotFoundError as exc:
            raise SafeFailure("changed") from exc
        if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(named_before.st_mode):
            raise SafeFailure("unsafe_file")
        if before.st_dev != named_before.st_dev or before.st_ino != named_before.st_ino:
            raise SafeFailure("changed")
        if required_mode is not None and stat.S_IMODE(before.st_mode) != required_mode:
            raise SafeFailure("unsafe_mode")
        if not _identity_matches(before, expected, include_nlink=True):
            raise SafeFailure("changed")
        if before.st_size > max_bytes:
            raise SafeFailure("too_large")

        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise SafeFailure("too_large")
            digest.update(chunk)
            if total == max_bytes:
                extra = os.read(descriptor, 1)
                if extra:
                    raise SafeFailure("too_large")
                break

        after = os.fstat(descriptor)
        try:
            named_after = os.stat(name, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        except FileNotFoundError as exc:
            raise SafeFailure("changed") from exc
        if total != before.st_size or not _same_snapshot(before, after):
            raise SafeFailure("changed")
        if after.st_dev != named_after.st_dev or after.st_ino != named_after.st_ino:
            raise SafeFailure("changed")
        if not _same_snapshot(after, named_after):
            raise SafeFailure("changed")
        if digest.hexdigest() != expected_sha256:
            raise SafeFailure("hash_mismatch")
        return descriptor, after
    except Exception:
        os.close(descriptor)
        raise


def _link(request: Dict[str, Any]) -> None:
    source = _name(request.get("source"))
    target = _name(request.get("target"))
    expected = _fingerprint(request.get("fingerprint"))
    expected_hash = _sha(request.get("sha256"))
    max_bytes = _limit(request.get("maxBytes"))
    required_mode = request.get("requiredMode")
    if required_mode is not None and (not isinstance(required_mode, int) or isinstance(required_mode, bool)):
        raise SafeFailure("invalid_mode")

    descriptor, source_before = _read_verified(
        source, expected, expected_hash, max_bytes, required_mode
    )
    try:
        try:
            os.link(
                source,
                target,
                src_dir_fd=DIRECTORY_FD,
                dst_dir_fd=DIRECTORY_FD,
                follow_symlinks=False,
            )
        except FileExistsError:
            _answer("exists")
            return
        except OSError as exc:
            if exc.errno == errno.EXDEV:
                raise SafeFailure("cross_device") from exc
            raise SafeFailure("io_failure") from exc

        source_after = os.fstat(descriptor)
        try:
            target_after = os.stat(target, dir_fd=DIRECTORY_FD, follow_symlinks=False)
        except FileNotFoundError as exc:
            raise SafeFailure("link_uncertain") from exc
        if (
            source_after.st_dev != source_before.st_dev
            or source_after.st_ino != source_before.st_ino
            or source_after.st_size != source_before.st_size
            or source_after.st_mtime_ns != source_before.st_mtime_ns
            or source_after.st_mode != source_before.st_mode
            or target_after.st_dev != source_before.st_dev
            or target_after.st_ino != source_before.st_ino
            or target_after.st_size != source_before.st_size
            or target_after.st_mtime_ns != source_before.st_mtime_ns
            or target_after.st_mode != source_before.st_mode
            or not stat.S_ISREG(target_after.st_mode)
            or source_after.st_nlink != source_before.st_nlink + 1
        ):
            raise SafeFailure("link_uncertain")
        os.lseek(descriptor, 0, os.SEEK_SET)
        post_link_digest = hashlib.sha256()
        post_link_total = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, max_bytes + 1 - post_link_total))
            if not chunk:
                break
            post_link_total += len(chunk)
            if post_link_total > max_bytes:
                raise SafeFailure("link_uncertain")
            post_link_digest.update(chunk)
            if post_link_total == max_bytes:
                if os.read(descriptor, 1):
                    raise SafeFailure("link_uncertain")
                break
        final_source = os.fstat(descriptor)
        if (
            final_source.st_dev != source_after.st_dev
            or final_source.st_ino != source_after.st_ino
            or final_source.st_size != source_after.st_size
            or final_source.st_mtime_ns != source_after.st_mtime_ns
            or final_source.st_mode != source_after.st_mode
            or final_source.st_nlink != source_after.st_nlink
            or post_link_total != source_after.st_size
            or post_link_digest.hexdigest() != expected_hash
        ):
            raise SafeFailure("link_uncertain")
        _answer("linked")
    finally:
        os.close(descriptor)


def _unlink(request: Dict[str, Any]) -> None:
    name = _name(request.get("name"))
    expected = _fingerprint(request.get("fingerprint"))
    expected_hash = _sha(request.get("sha256"))
    max_bytes = _limit(request.get("maxBytes"))
    required_mode = request.get("requiredMode")
    if required_mode is not None and (not isinstance(required_mode, int) or isinstance(required_mode, bool)):
        raise SafeFailure("invalid_mode")

    descriptor, before = _read_verified(name, expected, expected_hash, max_bytes, required_mode)
    try:
        try:
            os.unlink(name, dir_fd=DIRECTORY_FD)
        except FileNotFoundError:
            _answer("changed")
            return
        except OSError as exc:
            raise SafeFailure("io_failure") from exc

        after = os.fstat(descriptor)
        if (
            after.st_dev != before.st_dev
            or after.st_ino != before.st_ino
            or after.st_nlink != before.st_nlink - 1
        ):
            _answer("uncertain")
            return
        _answer("unlinked", linksBefore=str(before.st_nlink), linksAfter=str(after.st_nlink))
    finally:
        os.close(descriptor)


def main() -> None:
    directory_stat = os.fstat(DIRECTORY_FD)
    if not stat.S_ISDIR(directory_stat.st_mode):
        raise SafeFailure("unsafe_directory")
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise SafeFailure("request_too_large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SafeFailure("invalid_request") from exc
    if not isinstance(request, dict):
        raise SafeFailure("invalid_request")
    private_directory = request.get("privateDirectory", False)
    if not isinstance(private_directory, bool):
        raise SafeFailure("invalid_request")
    if private_directory and stat.S_IMODE(directory_stat.st_mode) != 0o700:
        raise SafeFailure("unsafe_directory")
    operation = request.get("operation")
    if operation == "link":
        _link(request)
        return
    if operation == "unlink":
        _unlink(request)
        return
    raise SafeFailure("invalid_operation")


if __name__ == "__main__":
    try:
        main()
    except SafeFailure as failure:
        _answer("error", code=failure.code)
    except Exception:
        _answer("error", code="helper_failure")
