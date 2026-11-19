#!/usr/bin/env python3
"""Физическое создание control root с повторяемой синхронизацией имён."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path


FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def identify(descriptor: int, info: os.stat_result) -> None:
    """Сверяет удержанный descriptor с именем перед использованием."""
    held = os.fstat(descriptor)
    if not stat.S_ISDIR(held.st_mode) or (held.st_dev, held.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError("изменилось поколение каталога")


def physical_parents(root: Path, boundary: Path | None, *, create: bool = True,
                     expected_fd: int | None = None) -> None:
    """Walk от удержанного ancestor. При retry заново fsync все управляемые имена."""
    if not root.is_absolute() or root == Path("/") or root != Path(os.path.normpath(root)) \
            or any(char in str(root) for char in "\n\r\t"):
        raise ValueError("некорректный control path")
    if boundary is not None and (boundary.resolve(strict=True) != boundary
                                  or not root.is_relative_to(boundary) or root == boundary):
        raise ValueError("control path вне доверенного ancestor")
    start = boundary if boundary is not None else Path("/")
    directory = os.open(start, FLAGS)
    enforcing = boundary is not None
    try:
        if enforcing:
            anchor = os.fstat(directory)
            if anchor.st_uid != os.geteuid() or anchor.st_mode & 0o022:
                raise ValueError("ancestor нельзя подтвердить")
        for name in root.relative_to(start).parts:
            try:
                before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(name, mode=0o700, dir_fd=directory)
                before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                enforcing = True
            child = os.open(name, FLAGS, dir_fd=directory)
            try:
                identify(child, before)
                protected = before.st_uid == os.geteuid() and before.st_mode & 0o022 == 0
                if enforcing and not protected:
                    raise ValueError("неподтверждённый inode под control root")
                enforcing = enforcing or protected
                if enforcing and create:
                    os.fsync(child)
                    os.fsync(directory)
                    identify(child, os.stat(name, dir_fd=directory, follow_symlinks=False))
            except BaseException:
                os.close(child)
                raise
            os.close(directory)
            directory = child
        final = os.fstat(directory)
        if final.st_uid != os.geteuid() or final.st_mode & 0o022 or root.resolve(strict=True) != root:
            raise ValueError("неподтверждённый control root")
        if expected_fd is not None:
            identify(expected_fd, final)
    finally:
        os.close(directory)


if __name__ == "__main__":
    try:
        value, *rest = sys.argv[1:]
        held = value == "--verify-fd"
        verify = held or value == "--verify"
        if verify:
            value, *rest = rest
        if len(rest) > 1:
            raise ValueError("неверные аргументы")
        # Path нормализует trailing slash, сравниваем ещё исходное имя.
        root = Path(value)
        if str(root) != value:
            raise ValueError("неканонический путь")
        physical_parents(root, Path(rest[0]) if rest else None, create=not verify,
                         expected_fd=3 if held else None)
        print(value)
    except (OSError, ValueError):
        print("factory: не удалось синхронизировать control root", file=sys.stderr)
        sys.exit(78)
