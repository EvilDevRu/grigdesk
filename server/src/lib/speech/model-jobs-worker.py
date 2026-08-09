#!/usr/bin/env python3
"""Detached worker model jobs. Получает только server-owned status JSON и nonce."""

from __future__ import annotations

import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


class JobCancelled(Exception):
    pass


STATUS_PATH = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
EXPECTED_NONCE = sys.argv[2] if len(sys.argv) > 2 else ""
WRITE_LOCK = threading.Lock()


def read_job() -> dict[str, Any]:
    if STATUS_PATH is None:
        raise RuntimeError("status path не передан")
    return json.loads(STATUS_PATH.read_text(encoding="utf-8"))


def atomic_write(job: dict[str, Any]) -> None:
    if STATUS_PATH is None:
        return
    temp = STATUS_PATH.with_name(f"{STATUS_PATH.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = None
    try:
        # mode применяется самим open(2): write_text + последующий chmod оставляли
        # короткое окно с правами, зависящими от umask процесса.
        descriptor = os.open(temp, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = None
            json.dump(job, stream, ensure_ascii=False, indent=2)
        os.replace(temp, STATUS_PATH)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temp.unlink(missing_ok=True)


def mutate(change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    with WRITE_LOCK:
        job = read_job()
        change(job)
        atomic_write(job)
        return job


def terminal(job: dict[str, Any]) -> bool:
    return job.get("status") in {"done", "failed", "cancelled", "interrupted"}


def wait_for_identity() -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = read_job()
        if terminal(job):
            return job
        process = job.get("process") or {}
        task = job.get("task") or {}
        if (job.get("status") == "running"
                and process.get("pid") == os.getpid()
                and task.get("nonce") == EXPECTED_NONCE
                and process.get("nonce") == EXPECTED_NONCE):
            return job
        time.sleep(0.01)
    raise RuntimeError("manager не закрепил process identity worker-а")


def cancel_handler(_signum: int, _frame: Any) -> None:
    raise JobCancelled()


def report_progress(done: float, total: float, filename: str = "") -> None:
    def update(job: dict[str, Any]) -> None:
        if terminal(job):
            raise JobCancelled()
        job["progress"] = {"done": float(done), "total": float(total), "file": filename}

    mutate(update)


def source_hub(source_env: dict[str, str]) -> Path:
    # Приоритеты переменных принадлежат huggingface_hub. Worker уже запущен с
    # cockpit HF_HOME, поэтому спрашиваем библиотеку в отдельном процессе с исходным
    # окружением сервера, вместо того чтобы дублировать её правила здесь.
    env = dict(os.environ)
    for name in ("HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_XET_CACHE"):
        env.pop(name, None)
    env.update(source_env)
    result = subprocess.run(
        [sys.executable, "-c", "from huggingface_hub.constants import HF_HUB_CACHE; print(HF_HUB_CACHE)"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("huggingface_hub не вернул путь общего кэша")
    return Path(value)


def metadata_value(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def remaining_download_bytes(info: Any, target_model: Path) -> int:
    remaining = 0
    blobs = target_model / "blobs"
    for sibling in info.siblings or []:
        lfs = metadata_value(sibling, "lfs")
        size = metadata_value(sibling, "size") or metadata_value(lfs, "size")
        if not size:
            continue
        blob_id = metadata_value(lfs, "sha256") or metadata_value(sibling, "blob_id")
        present = 0
        if blob_id:
            for candidate in (blobs / str(blob_id), blobs / f"{blob_id}.incomplete"):
                try:
                    present = max(present, candidate.stat().st_size)
                except OSError:
                    pass
        remaining += max(0, int(size) - present)
    return remaining


def model_dir_name(repo: str) -> str:
    return "models--" + repo.replace("/", "--")


def download(task: dict[str, Any]) -> dict[str, Any]:
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE
    from tqdm.auto import tqdm

    model = task["model"]

    # Метаданные всё равно запрашиваются сетевой download-задачей. Для resume вычитаем
    # уже готовые blobs и байты *.incomplete, не смешивая их с чужими ревизиями модели.
    info = HfApi().model_info(
        repo_id=model["repo"], revision=model["revision"], files_metadata=True,
    )
    target_hub = Path(HF_HUB_CACHE)
    target_hub.mkdir(parents=True, exist_ok=True)
    target_model = target_hub / model_dir_name(model["repo"])
    remaining = remaining_download_bytes(info, target_model)
    if remaining and shutil.disk_usage(target_hub).free < remaining:
        raise OSError(errno.ENOSPC, "недостаточно свободного места для скачивания модели")

    class StatusTqdm(tqdm):
        def update(self, n: float = 1) -> bool | None:
            result = super().update(n)
            report_progress(float(self.n), float(self.total or 0), str(self.desc or ""))
            return result

        def close(self) -> None:
            if not self.disable:
                report_progress(float(self.n), float(self.total or self.n or 0), str(self.desc or ""))
            super().close()

    snapshot_download(
        repo_id=model["repo"],
        revision=model["revision"],
        tqdm_class=StatusTqdm,
    )
    # Успех означает не «процесс вернул 0», а pinned snapshot полностью читается offline.
    snapshot_download(
        repo_id=model["repo"],
        revision=model["revision"],
        local_files_only=True,
    )
    return {
        "modelId": model["modelId"],
        "repo": model["repo"],
        "revision": model["revision"],
        "cached": True,
    }


def tree_size(root: Path) -> int:
    total = 0
    for current, _dirs, files in os.walk(root):
        for name in files:
            source = Path(current) / name
            if not source.is_symlink():
                total += source.stat().st_size
    return total


def copy_tree(source: Path, destination: Path, total: int) -> None:
    copied = 0
    for current, dirs, files in os.walk(source):
        relative = Path(current).relative_to(source)
        target_dir = destination / relative
        target_dir.mkdir(parents=True, exist_ok=True)
        for dirname in dirs:
            source_dir = Path(current) / dirname
            target = target_dir / dirname
            if source_dir.is_symlink():
                target.symlink_to(os.readlink(source_dir), target_is_directory=True)
        for filename in files:
            source_file = Path(current) / filename
            target = target_dir / filename
            if source_file.is_symlink():
                target.symlink_to(os.readlink(source_file))
            else:
                shutil.copy2(source_file, target)
                copied += source_file.stat().st_size
                report_progress(copied, total, str(relative / filename))


def copy_cached(task: dict[str, Any], job_id: str) -> dict[str, Any]:
    from huggingface_hub import snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE

    model = task["model"]
    source_cache = source_hub(task.get("sourceCacheEnv") or {})
    target_hub = Path(HF_HUB_CACHE)
    target_hub.mkdir(parents=True, exist_ok=True)
    repos = [model["repo"], *(model.get("aliases") or [])]
    for repo in repos:
        target_model = target_hub / model_dir_name(repo)
        if not target_model.exists():
            continue
        try:
            snapshot_download(
                repo_id=repo, revision=model["revision"], local_files_only=True,
            )
            return {
                "modelId": model["modelId"],
                "repo": repo,
                "revision": model["revision"],
                "cached": True,
                "alreadyPresent": True,
            }
        except Exception:
            # Возможно, рядом есть целый alias. Если нет — ниже не перезапишем этот
            # неполный каталог молча, а вернём явную ошибку.
            pass

    source_snapshot = None
    source_repo = None
    last_source_error = None
    for repo in repos:
        try:
            source_snapshot = Path(snapshot_download(
                repo_id=repo,
                revision=model["revision"],
                cache_dir=str(source_cache),
                local_files_only=True,
            ))
            source_repo = repo
            break
        except Exception as exc:
            last_source_error = exc
    if source_snapshot is None or source_repo is None:
        raise FileNotFoundError(
            "pinned snapshot не найден в общем HF-кэше ни по canonical repo, ни по alias"
        ) from last_source_error

    source_model = source_snapshot.parent.parent
    target_model = target_hub / model_dir_name(source_repo)
    if target_model.exists():
        raise RuntimeError("целевой HF-кэш уже содержит неполный каталог этой модели")

    size = tree_size(source_model)
    if shutil.disk_usage(target_hub).free < size:
        raise OSError("недостаточно свободного места для копирования модели")
    temp_root = target_hub / f".cockpit-copy-{job_id}"
    temp_hub = temp_root / "hub"
    temp_model = temp_hub / target_model.name
    try:
        temp_hub.mkdir(parents=True, exist_ok=True)
        copy_tree(source_model, temp_model, size)
        snapshot_download(
            repo_id=source_repo,
            revision=model["revision"],
            cache_dir=str(temp_hub),
            local_files_only=True,
        )
        if target_model.exists():
            snapshot_download(
                repo_id=source_repo, revision=model["revision"], local_files_only=True,
            )
        else:
            os.replace(temp_model, target_model)
            snapshot_download(
                repo_id=source_repo, revision=model["revision"], local_files_only=True,
            )
    finally:
        # Исходный общий кэш не трогаем. Частичный временный target после отмены или
        # ошибки не нужен: resume относится к *.incomplete downloader-а, не к copy.
        shutil.rmtree(temp_root, ignore_errors=True)
    return {
        "modelId": model["modelId"],
        "repo": source_repo,
        "revision": model["revision"],
        "cached": True,
        "copiedBytes": size,
    }


def benchmark(task: dict[str, Any]) -> dict[str, Any]:
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download

    model = task["model"]
    options = task.get("benchmark") or {}
    audio = Path(task.get("benchmarkAudioPath") or "")
    if not audio.is_file():
        raise FileNotFoundError("эталонная запись benchmark не настроена")
    snapshot = None
    last_snapshot_error = None
    for repo in [model["repo"], *(model.get("aliases") or [])]:
        try:
            snapshot = snapshot_download(
                repo_id=repo,
                revision=model["revision"],
                local_files_only=True,
            )
            break
        except Exception as exc:
            last_snapshot_error = exc
    if snapshot is None:
        raise FileNotFoundError(
            "pinned snapshot benchmark не найден ни по canonical repo, ни по alias"
        ) from last_snapshot_error
    started = time.perf_counter()
    whisper = WhisperModel(
        snapshot,
        device=options.get("device", "cpu"),
        compute_type=options.get("computeType", "int8"),
        local_files_only=True,
    )
    language = options.get("language", "ru")
    segments, info = whisper.transcribe(
        str(audio), language=None if language == "auto" else language,
    )
    list(segments)
    elapsed = time.perf_counter() - started
    return {
        "modelId": model["modelId"],
        "audioSec": round(float(info.duration or 0), 3),
        "elapsedSec": round(elapsed, 3),
        "realtimeFactor": (
            round(elapsed / float(info.duration), 3) if float(info.duration or 0) > 0 else None
        ),
    }


def error_code(exc: BaseException, kind: str) -> str:
    message = str(exc).lower()
    if kind == "copy" and isinstance(exc, FileNotFoundError):
        return "speech_model_source_missing"
    if kind == "benchmark" and isinstance(exc, FileNotFoundError):
        return "speech_benchmark_unavailable"
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return "speech_model_no_space"
    if "свободного места" in message:
        return "speech_model_no_space"
    return "model_job_failed"


def finish(status: str, *, result: Any = None, error: Any = None) -> None:
    def update(job: dict[str, Any]) -> None:
        # Recovery/cancel manager-а сильнее позднего финала прежнего worker-а.
        if job.get("status") in {"interrupted", "cancelled"}:
            return
        job["status"] = status
        job["finishedAt"] = int(time.time() * 1000)
        job["result"] = result
        job["error"] = error

    mutate(update)


def main() -> int:
    if STATUS_PATH is None or not EXPECTED_NONCE:
        return 2
    signal.signal(signal.SIGTERM, cancel_handler)
    signal.signal(signal.SIGINT, cancel_handler)
    job: dict[str, Any] = {}
    try:
        job = wait_for_identity()
        if terminal(job):
            return 0
        task = job.get("task") or {}
        if task.get("nonce") != EXPECTED_NONCE:
            raise RuntimeError("nonce model job не совпал")
        kind = job.get("kind")
        if kind == "download":
            result = download(task)
        elif kind == "copy":
            result = copy_cached(task, job["jobId"])
        elif kind == "benchmark":
            result = benchmark(task)
        else:
            raise RuntimeError(f"неизвестный kind: {kind}")
        finish("done", result=result)
        return 0
    except JobCancelled:
        finish("cancelled")
        return 0
    except BaseException as exc:  # worker всегда оставляет терминальный status
        finish("failed", error={
            "code": error_code(exc, str(job.get("kind") or "")),
            "message": str(exc),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
