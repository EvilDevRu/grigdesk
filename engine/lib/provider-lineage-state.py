#!/usr/bin/env python3
"""Устойчивое к сбоям CAS-хранилище цепочки возобновления нативной сессии провайдера."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time
from dataclasses import dataclass
from typing import Any, NoReturn


JSON_LIMIT = 64 * 1024
SAFE_INTEGER = 9_007_199_254_740_991
CHAIN_STATES = {
    "reserved_before_start",
    "started",
    "advanced",
    "cancelled_before_start",
    "blocked_after_start",
}
RECORD_HASH_FIELDS = {
    "predecessorUsageDocumentHash",
    "predecessorCheckpointHash",
    "predecessorRunnerUsageRecordedEventHash",
    "predecessorScopeBoundEventHash",
}
CANCELLATION_PROOF_KEYS = {
    "neverReleased",
    "processSessionQuiesced",
    "neverReleasedEvidenceHash",
    "quiescenceEvidenceHash",
}
BLOCK_PROOF_KEYS = {"reasonCode", "evidenceHash"}


class LineageFailure(Exception):
    def __init__(self, name: str, message: str, code: int = 78):
        super().__init__(message)
        self.name = name
        self.message = message
        self.code = code


def fail(name: str, message: str, code: int = 78) -> NoReturn:
    raise LineageFailure(name, message, code)


def exact_object(value: Any, keys: set[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail("provider-lineage-schema-invalid", f"{where}: expected exact keys")
    return value


def _reject_float(value: str) -> NoReturn:
    fail("provider-lineage-schema-invalid", f"JSON number {value!r} is outside safe-integer subset")


def _reject_constant(value: str) -> NoReturn:
    fail("provider-lineage-schema-invalid", f"non-JSON number {value!r} is forbidden")


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            fail("provider-lineage-schema-invalid", f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def strict_json(data: bytes, where: str) -> Any:
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        fail("provider-lineage-schema-invalid", f"{where}: invalid UTF-8 ({error})")
    try:
        return json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
        )
    except LineageFailure:
        raise
    except (RecursionError, TypeError, ValueError) as error:
        fail("provider-lineage-schema-invalid", f"{where}: invalid JSON ({error})")


@dataclass
class CanonicalBudget:
    values: int = 0


def _assert_unicode(value: str, where: str) -> None:
    for char in value:
        if 0xD800 <= ord(char) <= 0xDFFF:
            fail("provider-lineage-schema-invalid", f"{where}: unpaired surrogate is forbidden")


def _canonical(value: Any, budget: CanonicalBudget, where: str, depth: int) -> str:
    budget.values += 1
    if budget.values > 10_000:
        fail("provider-lineage-schema-invalid", "canonical JSON exceeds 10000 values")
    if depth > 32:
        fail("provider-lineage-schema-invalid", "canonical JSON exceeds depth 32")
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not -SAFE_INTEGER <= value <= SAFE_INTEGER:
            fail("provider-lineage-schema-invalid", f"{where}: integer is not IEEE-754 safe")
        return str(value)
    if isinstance(value, float):
        fail("provider-lineage-schema-invalid", f"{where}: only safe integer numbers are allowed")
    if isinstance(value, str):
        _assert_unicode(value, where)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(
            _canonical(item, budget, f"{where}[{index}]", depth + 1)
            for index, item in enumerate(value)
        ) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                fail("provider-lineage-schema-invalid", f"{where}: object key is not a string")
            _assert_unicode(key, f"{where} key")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "strict"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            + ":"
            + _canonical(value[key], budget, f"{where}.{key}", depth + 1)
            for key in keys
        ) + "}"
    fail("provider-lineage-schema-invalid", f"{where}: value is not JSON-safe")


def canonical_bytes(value: Any) -> bytes:
    encoded = _canonical(value, CanonicalBudget(), "$", 0).encode("utf-8", "strict")
    if len(encoded) > JSON_LIMIT:
        fail("provider-lineage-schema-invalid", f"canonical JSON exceeds {JSON_LIMIT} bytes")
    return encoded


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_request(path: str) -> Any:
    try:
        info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or info.st_size > JSON_LIMIT
        ):
            fail("provider-lineage-schema-invalid", f"{path}: request must be one bounded owned file")
        flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                fail("provider-lineage-schema-invalid", f"{path}: request identity changed")
            data = os.read(descriptor, JSON_LIMIT + 1)
            if len(data) > JSON_LIMIT or os.read(descriptor, 1):
                fail("provider-lineage-schema-invalid", f"{path}: request exceeds {JSON_LIMIT} bytes")
            after = os.fstat(descriptor)
            current = os.lstat(path)
            if (
                (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns)
                or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                or (current.st_size, current.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns)
            ):
                fail("provider-lineage-schema-invalid", f"{path}: request path identity changed")
        finally:
            os.close(descriptor)
    except LineageFailure:
        raise
    except OSError as error:
        fail("provider-lineage-schema-invalid", f"{path}: cannot read request ({error})")
    if not data.endswith(b"\n") or data.endswith(b"\n\n"):
        fail(
            "provider-lineage-schema-invalid",
            f"{path}: request is not one newline-terminated JSON object",
        )
    value = strict_json(data[:-1], "request")
    if canonical_bytes(value) + b"\n" != data:
        fail("provider-lineage-schema-invalid", f"{path}: request is not canonical JSON")
    return value


class Contract:
    REQUEST_DEFINITION = {
        "initialize": "initializeRequest",
        "reserve": "reserveRequest",
        "started": "startedRequest",
        "advance": "advanceRequest",
        "cancel": "cancelRequest",
        "block": "blockRequest",
    }

    def __init__(self, schema_path: str):
        try:
            with open(schema_path, "rb") as source:
                data = source.read(JSON_LIMIT + 1)
        except OSError as error:
            fail("provider-lineage-schema-invalid", f"cannot read shared schema ({error})")
        if len(data) > JSON_LIMIT:
            fail("provider-lineage-schema-invalid", "shared schema exceeds bounded size")
        schema = strict_json(data, "shared schema")
        if not isinstance(schema, dict):
            fail("provider-lineage-schema-invalid", "shared schema must be an object")
        self.schema = schema
        self.defs = schema.get("$defs")
        self.properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(self.defs, dict) or not isinstance(self.properties, dict) or not isinstance(required, list):
            fail("provider-lineage-schema-invalid", "shared schema shape is incompatible")
        self.record_keys = set(required)
        if self.record_keys != set(self.properties):
            fail("provider-lineage-schema-invalid", "record properties/required drift")
        self.states = set(self.definition("state").get("enum", []))
        self.block_reasons = set(
            self.definition("blockProof").get("properties", {}).get("reasonCode", {}).get("enum", [])
        )
        if self.states != CHAIN_STATES or not self.block_reasons:
            fail("provider-lineage-schema-invalid", "shared state/proof enums are incompatible")

    def definition(self, name: str) -> dict[str, Any]:
        value = self.defs.get(name)
        if not isinstance(value, dict):
            fail("provider-lineage-schema-invalid", f"shared schema misses $defs.{name}")
        return value

    def pattern(self, name: str) -> re.Pattern[str]:
        pattern = self.definition(name).get("pattern")
        if not isinstance(pattern, str):
            fail("provider-lineage-schema-invalid", f"shared schema misses pattern for {name}")
        return re.compile(pattern)

    def request_keys(self, operation: str) -> set[str]:
        definition = self.definition(self.REQUEST_DEFINITION[operation])
        required = definition.get("required")
        properties = definition.get("properties")
        if not isinstance(required, list) or not isinstance(properties, dict) or set(required) != set(properties):
            fail("provider-lineage-schema-invalid", f"shared {operation} request shape drift")
        return set(required)


def matches(pattern: re.Pattern[str], value: Any, where: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        fail("provider-lineage-schema-invalid", f"{where}: invalid value")
    return value


def nullable_match(pattern: re.Pattern[str], value: Any, where: str) -> None:
    if value is not None:
        matches(pattern, value, where)


def safe_integer(value: Any, where: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= SAFE_INTEGER:
        fail("provider-lineage-schema-invalid", f"{where}: expected safe integer >= {minimum}")
    return value


def validate_provider_scope(provider: Any, thread_id: Any, contract: Contract) -> tuple[str, str]:
    provider = matches(contract.pattern("provider"), provider, "provider")
    thread_id = matches(contract.pattern("threadId"), thread_id, "threadId")
    if len(thread_id.encode("utf-8")) > 512:
        fail("provider-lineage-schema-invalid", "threadId exceeds 512 UTF-8 bytes")
    return provider, thread_id


def validate_cancellation_proof(value: Any, contract: Contract) -> dict[str, Any]:
    proof = exact_object(value, CANCELLATION_PROOF_KEYS, "cancellationProof")
    if proof["neverReleased"] is not True or proof["processSessionQuiesced"] is not True:
        fail(
            "provider-lineage-schema-invalid",
            "cancellation requires neverReleased=true and processSessionQuiesced=true",
        )
    matches(contract.pattern("sha256"), proof["neverReleasedEvidenceHash"], "neverReleasedEvidenceHash")
    matches(contract.pattern("sha256"), proof["quiescenceEvidenceHash"], "quiescenceEvidenceHash")
    return proof


def validate_block_proof(value: Any, contract: Contract) -> dict[str, Any]:
    proof = exact_object(value, BLOCK_PROOF_KEYS, "blockProof")
    if proof["reasonCode"] not in contract.block_reasons:
        fail("provider-lineage-schema-invalid", "blockProof.reasonCode: unknown code")
    matches(contract.pattern("sha256"), proof["evidenceHash"], "blockProof.evidenceHash")
    return proof


def validate_request(operation: str, value: Any, contract: Contract) -> dict[str, Any]:
    request = exact_object(value, contract.request_keys(operation), f"{operation} request")
    if request["schemaVersion"] != 1 or request["protocolVersion"] != 2:
        fail("provider-lineage-schema-invalid", "request schema/protocol version is unsupported")
    validate_provider_scope(request["provider"], request["threadId"], contract)
    hash_pattern = contract.pattern("sha256")
    run_pattern = contract.pattern("runId")
    reservation_pattern = contract.pattern("reservationId")
    if operation == "initialize":
        if request["lineageGeneration"] != 0:
            fail("provider-lineage-schema-invalid", "fresh lineage must initialize generation zero")
        matches(run_pattern, request["runId"], "runId")
        for field in (
            "usageDocumentHash",
            "checkpointHash",
            "runnerUsageRecordedEventHash",
            "runnerScopeBoundEventHash",
        ):
            matches(hash_pattern, request[field], field)
        if request["usageCompleteness"] != "complete" or request["resumeEligible"] is not True:
            fail("provider-lineage-schema-invalid", "initial checkpoint must be complete and resumeEligible")
    elif operation == "reserve":
        safe_integer(request["expectedStateRevision"], "expectedStateRevision", 1)
        safe_integer(request["lineageGeneration"], "lineageGeneration", 1)
        matches(run_pattern, request["predecessorRunId"], "predecessorRunId")
        matches(hash_pattern, request["predecessorUsageDocumentHash"], "predecessorUsageDocumentHash")
        matches(hash_pattern, request["predecessorCheckpointHash"], "predecessorCheckpointHash")
        matches(reservation_pattern, request["reservationId"], "reservationId")
        matches(run_pattern, request["childRunId"], "childRunId")
        if request["predecessorRunId"] == request["childRunId"]:
            fail("provider-lineage-schema-invalid", "childRunId must differ from predecessorRunId")
    elif operation == "started":
        safe_integer(request["expectedStateRevision"], "expectedStateRevision", 1)
        matches(reservation_pattern, request["reservationId"], "reservationId")
        matches(run_pattern, request["childRunId"], "childRunId")
        matches(hash_pattern, request["runnerStartedEventHash"], "runnerStartedEventHash")
    elif operation == "advance":
        safe_integer(request["expectedStateRevision"], "expectedStateRevision", 1)
        matches(reservation_pattern, request["reservationId"], "reservationId")
        matches(run_pattern, request["childRunId"], "childRunId")
        for field in (
            "usageDocumentHash",
            "checkpointHash",
            "runnerUsageRecordedEventHash",
            "runnerScopeBoundEventHash",
        ):
            matches(hash_pattern, request[field], field)
        if request["usageCompleteness"] != "complete" or request["resumeEligible"] is not True:
            fail("provider-lineage-schema-invalid", "advance requires complete resumeEligible checkpoint")
    elif operation == "cancel":
        safe_integer(request["expectedStateRevision"], "expectedStateRevision", 1)
        matches(reservation_pattern, request["reservationId"], "reservationId")
        matches(run_pattern, request["childRunId"], "childRunId")
        validate_cancellation_proof(request["cancellationProof"], contract)
    elif operation == "block":
        safe_integer(request["expectedStateRevision"], "expectedStateRevision", 1)
        matches(reservation_pattern, request["reservationId"], "reservationId")
        matches(run_pattern, request["childRunId"], "childRunId")
        validate_block_proof(request["blockProof"], contract)
    else:
        fail("provider-lineage-argument-invalid", f"unknown operation {operation!r}", 2)
    canonical_bytes(request)
    return request


def scope_canonical(provider: str, thread_id: str, contract: Contract) -> bytes:
    provider, thread_id = validate_provider_scope(provider, thread_id, contract)
    return canonical_bytes({"provider": provider, "threadId": thread_id})


def scope_hash(provider: str, thread_id: str, contract: Contract) -> str:
    return sha256(scope_canonical(provider, thread_id, contract))


def validate_record(value: Any, contract: Contract) -> dict[str, Any]:
    record = exact_object(value, contract.record_keys, "provider lineage record")
    if record["schemaVersion"] != 1 or record["protocolVersion"] != 2:
        fail("provider-lineage-schema-invalid", "record schema/protocol version is unsupported")
    provider, thread_id = validate_provider_scope(record["provider"], record["threadId"], contract)
    matches(contract.pattern("sha256"), record["scopeSha256"], "scopeSha256")
    if record["scopeSha256"] != scope_hash(provider, thread_id, contract):
        fail("provider-lineage-schema-invalid", "scopeSha256 does not match canonical provider/threadId")
    safe_integer(record["stateRevision"], "stateRevision", 1)
    generation = safe_integer(record["lineageGeneration"], "lineageGeneration")
    state = record["state"]
    if state not in contract.states:
        fail("provider-lineage-schema-invalid", "state: unknown provider lineage state")
    reservation_pattern = contract.pattern("reservationId")
    run_pattern = contract.pattern("runId")
    hash_pattern = contract.pattern("sha256")
    nullable_match(reservation_pattern, record["reservationId"], "reservationId")
    nullable_match(run_pattern, record["predecessorRunId"], "predecessorRunId")
    nullable_match(run_pattern, record["childRunId"], "childRunId")
    nullable_match(hash_pattern, record["runnerStartedEventHash"], "runnerStartedEventHash")
    for field in RECORD_HASH_FIELDS:
        nullable_match(hash_pattern, record[field], field)
    if record["writerVersion"] != "provider-lineage-state/1":
        fail("provider-lineage-schema-invalid", "writerVersion is unsupported")
    if state == "advanced":
        for field in RECORD_HASH_FIELDS | {"predecessorRunId", "childRunId"}:
            if record[field] is None:
                fail("provider-lineage-schema-invalid", f"advanced.{field} cannot be null")
        if record["predecessorRunId"] != record["childRunId"]:
            fail("provider-lineage-schema-invalid", "advanced child must be current predecessor")
        if record["cancellationProof"] is not None or record["blockProof"] is not None:
            fail("provider-lineage-schema-invalid", "advanced record cannot retain terminal proof")
        if generation == 0:
            if record["reservationId"] is not None or record["runnerStartedEventHash"] is not None:
                fail("provider-lineage-schema-invalid", "generation zero is a fresh checkpoint")
        elif record["reservationId"] is None or record["runnerStartedEventHash"] is None:
            fail("provider-lineage-schema-invalid", "resumed advanced checkpoint needs reservation/start refs")
    else:
        if generation < 1:
            fail("provider-lineage-schema-invalid", f"{state} requires generation >= 1")
        for field in RECORD_HASH_FIELDS | {"reservationId", "predecessorRunId", "childRunId"}:
            if record[field] is None:
                fail("provider-lineage-schema-invalid", f"{state}.{field} cannot be null")
        if record["predecessorRunId"] == record["childRunId"]:
            fail("provider-lineage-schema-invalid", f"{state} child must differ from predecessor")
        if state == "reserved_before_start":
            if any(
                record[field] is not None
                for field in ("runnerStartedEventHash", "cancellationProof", "blockProof")
            ):
                fail("provider-lineage-schema-invalid", "reserved record has forbidden proof")
        elif state == "started":
            if record["runnerStartedEventHash"] is None:
                fail("provider-lineage-schema-invalid", "started record needs runner_started hash")
            if record["cancellationProof"] is not None or record["blockProof"] is not None:
                fail("provider-lineage-schema-invalid", "started record has terminal proof")
        elif state == "cancelled_before_start":
            if record["runnerStartedEventHash"] is not None or record["blockProof"] is not None:
                fail("provider-lineage-schema-invalid", "cancelled record crossed launch barrier")
            validate_cancellation_proof(record["cancellationProof"], contract)
        elif state == "blocked_after_start":
            if record["runnerStartedEventHash"] is None or record["cancellationProof"] is not None:
                fail("provider-lineage-schema-invalid", "blocked record lacks started proof")
            validate_block_proof(record["blockProof"], contract)
    canonical_bytes(record)
    return record


def open_owned_directory(path: str) -> int:
    try:
        info = os.lstat(path)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            fail("provider-lineage-filesystem-invalid", f"{path}: expected owned directory mode 0700")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            os.close(descriptor)
            fail("provider-lineage-filesystem-invalid", f"{path}: directory identity changed")
        return descriptor
    except LineageFailure:
        raise
    except OSError as error:
        fail("provider-lineage-filesystem-invalid", f"{path}: unsafe directory ({error})")


def open_child_directory(parent: str, parent_fd: int, name: str, create: bool) -> tuple[str, int]:
    path = os.path.join(parent, name)
    created = False
    descriptor: int | None = None
    try:
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
                created = True
            except FileExistsError:
                pass
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.geteuid()
            or (not created and stat.S_IMODE(info.st_mode) != 0o700)
        ):
            fail("provider-lineage-filesystem-invalid", f"{path}: expected owned directory mode 0700")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(name, flags, dir_fd=parent_fd)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            os.close(descriptor)
            descriptor = None
            fail("provider-lineage-filesystem-invalid", f"{path}: directory identity changed")
        if created:
            os.fchmod(descriptor, 0o700)
            os.fsync(descriptor)
            os.fsync(parent_fd)
        elif stat.S_IMODE(opened.st_mode) != 0o700:
            os.close(descriptor)
            descriptor = None
            fail("provider-lineage-filesystem-invalid", f"{path}: expected directory mode 0700")
        elif create:
            # Предыдущий процесс мог упасть после mkdir, но до барьера каталога. Писатель
            # повторно открывает и fsync-ит каждый существующий компонент пути, поэтому
            # одного наблюдения достаточно, чтобы завершить прерванное создание.
            os.fsync(descriptor)
            os.fsync(parent_fd)
        return path, descriptor
    except LineageFailure:
        raise
    except FileNotFoundError:
        if not create:
            fail("provider-lineage-not-found", f"{path}: store directory is missing", 3)
        fail("provider-lineage-filesystem-invalid", f"{path}: created directory disappeared")
    except OSError as error:
        fail("provider-lineage-filesystem-invalid", f"{path}: cannot prepare directory ({error})")
    finally:
        if descriptor is not None and sys.exc_info()[0] is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def store_directory(control_root: str, provider: str, create: bool) -> tuple[str, int]:
    if os.path.abspath(control_root) != control_root or os.path.realpath(control_root) != control_root:
        fail("provider-lineage-filesystem-invalid", "control root is not canonical")
    current = control_root
    descriptor = open_owned_directory(current)
    try:
        for name in ("protocol-v2", "provider-lineage", "schema-1", provider):
            next_path, next_fd = open_child_directory(current, descriptor, name, create)
            os.close(descriptor)
            descriptor = next_fd
            current = next_path
        return current, descriptor
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise


def scope_lock(provider_dir: str, provider_fd: int, scope_sha: str, create: bool) -> int:
    name = f"{scope_sha}.lock"
    path, descriptor = open_child_directory(provider_dir, provider_fd, name, create)
    del path
    return descriptor


@dataclass(frozen=True)
class RecordSnapshot:
    device: int
    inode: int
    size: int
    mtime_ns: int
    digest: str


def read_record_file(
    provider_dir: str,
    provider_fd: int,
    scope_sha: str,
    provider: str,
    thread_id: str,
    contract: Contract,
) -> tuple[dict[str, Any], RecordSnapshot]:
    name = f"{scope_sha}.json"
    path = os.path.join(provider_dir, name)
    found = False
    try:
        info = os.stat(name, dir_fd=provider_fd, follow_symlinks=False)
        found = True
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > JSON_LIMIT
        ):
            fail("provider-lineage-corrupt", f"{path}: unsafe record inode/mode/size")
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=provider_fd,
        )
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                fail("provider-lineage-corrupt", f"{path}: record identity changed")
            data = os.read(descriptor, JSON_LIMIT + 1)
            if len(data) > JSON_LIMIT or os.read(descriptor, 1):
                fail("provider-lineage-corrupt", f"{path}: record exceeds bounded size")
            after = os.fstat(descriptor)
            current = os.stat(name, dir_fd=provider_fd, follow_symlinks=False)
            if (
                (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns)
                or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                or (current.st_size, current.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns)
                or current.st_uid != os.geteuid()
                or current.st_nlink != 1
                or stat.S_IMODE(current.st_mode) != 0o600
            ):
                fail("provider-lineage-corrupt", f"{path}: record changed while reading")
        finally:
            os.close(descriptor)
    except FileNotFoundError:
        if found:
            fail("provider-lineage-corrupt", f"{path}: record disappeared while reading")
        fail("provider-lineage-not-found", f"{path}: lineage does not exist", 3)
    except LineageFailure:
        raise
    except OSError as error:
        fail("provider-lineage-corrupt", f"{path}: cannot read record ({error})")
    try:
        if not data.endswith(b"\n") or data.endswith(b"\n\n"):
            fail("provider-lineage-corrupt", f"{path}: record is not one newline-terminated JSON object")
        value = strict_json(data[:-1], "provider lineage record")
        record = validate_record(value, contract)
        if canonical_bytes(record) + b"\n" != data:
            fail("provider-lineage-corrupt", f"{path}: record is not canonical JSON")
    except LineageFailure as error:
        if error.name == "provider-lineage-corrupt":
            raise
        fail("provider-lineage-corrupt", f"{path}: {error.name}: {error.message}")
    if record["provider"] != provider or record["threadId"] != thread_id or record["scopeSha256"] != scope_sha:
        fail("provider-lineage-corrupt", f"{path}: record identity does not match path")
    snapshot = RecordSnapshot(
        opened.st_dev,
        opened.st_ino,
        len(data),
        opened.st_mtime_ns,
        sha256(data),
    )
    return record, snapshot


def maybe_read_record(
    provider_dir: str,
    provider_fd: int,
    scope_sha: str,
    provider: str,
    thread_id: str,
    contract: Contract,
) -> tuple[dict[str, Any] | None, RecordSnapshot | None]:
    try:
        return read_record_file(provider_dir, provider_fd, scope_sha, provider, thread_id, contract)
    except LineageFailure as error:
        if error.code == 3:
            return None, None
        raise


def write_all(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            fail("provider-lineage-io-error", "short write while publishing record", 1)
        offset += written


def trace_step(step: str) -> None:
    trace = os.environ.get("PROVIDER_LINEAGE_TRACE_FILE")
    if trace and os.environ.get("FACTORY_TESTING") == "1":
        try:
            descriptor = os.open(trace, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC, 0o600)
            try:
                write_all(descriptor, (step + "\n").encode("utf-8"))
            finally:
                os.close(descriptor)
        except OSError:
            pass
    if (
        os.environ.get("FACTORY_TESTING") == "1"
        and os.environ.get("PROVIDER_LINEAGE_FAIL_AFTER") == step
    ):
        os._exit(91)


def test_pause_after_read() -> None:
    marker = os.environ.get("PROVIDER_LINEAGE_TEST_PAUSE_AFTER_READ")
    if not marker or os.environ.get("FACTORY_TESTING") != "1":
        return
    try:
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        os.close(descriptor)
    except OSError as error:
        fail("provider-lineage-test-error", f"cannot publish test pause marker ({error})", 1)
    release = marker + ".release"
    deadline = time.monotonic() + 10
    while not os.path.isfile(release):
        if time.monotonic() >= deadline:
            fail("provider-lineage-test-error", "test pause release timed out", 1)
        time.sleep(0.01)


def verify_snapshot(
    provider_dir: str,
    provider_fd: int,
    scope_sha: str,
    snapshot: RecordSnapshot | None,
) -> None:
    name = f"{scope_sha}.json"
    path = os.path.join(provider_dir, name)
    if snapshot is None:
        try:
            os.stat(name, dir_fd=provider_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError as error:
            fail(
                "provider-lineage-concurrent-conflict",
                f"cannot verify absent record under scope lock ({error})",
            )
        else:
            fail("provider-lineage-concurrent-conflict", "record appeared outside the scope lock")
    try:
        info = os.stat(name, dir_fd=provider_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > JSON_LIMIT
        ):
            fail("provider-lineage-concurrent-conflict", "record inode changed outside the scope lock")
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=provider_fd,
        )
        try:
            before = os.fstat(descriptor)
            data = os.read(descriptor, JSON_LIMIT + 1)
            opened = os.fstat(descriptor)
            current = os.stat(name, dir_fd=provider_fd, follow_symlinks=False)
        finally:
            os.close(descriptor)
    except LineageFailure:
        raise
    except OSError as error:
        fail("provider-lineage-concurrent-conflict", f"record changed outside scope lock ({error})")
    if (
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        fail("provider-lineage-concurrent-conflict", "record changed during CAS verification")
    current = RecordSnapshot(opened.st_dev, opened.st_ino, len(data), opened.st_mtime_ns, sha256(data))
    if current != snapshot:
        fail("provider-lineage-concurrent-conflict", "record changed outside the scope lock")


def publish_record(
    provider_dir: str,
    provider_fd: int,
    scope_sha: str,
    record: dict[str, Any],
    snapshot: RecordSnapshot | None,
    context: str,
    contract: Contract,
) -> None:
    validate_record(record, contract)
    data = canonical_bytes(record) + b"\n"
    temp_name = f".{scope_sha}.{secrets.token_hex(12)}.tmp"
    try:
        descriptor = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=provider_fd,
        )
        os.fchmod(descriptor, 0o600)
        try:
            write_all(descriptor, data)
            os.fsync(descriptor)
            trace_step(f"{context}:record_temp_fsync")
        finally:
            os.close(descriptor)
        verify_snapshot(provider_dir, provider_fd, scope_sha, snapshot)
        os.replace(
            temp_name,
            f"{scope_sha}.json",
            src_dir_fd=provider_fd,
            dst_dir_fd=provider_fd,
        )
        trace_step(f"{context}:record_rename")
        os.fsync(provider_fd)
        trace_step(f"{context}:provider_directory_fsync")
    except BaseException:
        try:
            os.unlink(temp_name, dir_fd=provider_fd)
        except OSError:
            pass
        raise


def base_record(request: dict[str, Any], scope_sha: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "protocolVersion": 2,
        "provider": request["provider"],
        "threadId": request["threadId"],
        "scopeSha256": scope_sha,
        "stateRevision": 1,
        "lineageGeneration": 0,
        "state": "advanced",
        "reservationId": None,
        "predecessorRunId": request["runId"],
        "predecessorUsageDocumentHash": request["usageDocumentHash"],
        "predecessorCheckpointHash": request["checkpointHash"],
        "predecessorRunnerUsageRecordedEventHash": request["runnerUsageRecordedEventHash"],
        "predecessorScopeBoundEventHash": request["runnerScopeBoundEventHash"],
        "childRunId": request["runId"],
        "runnerStartedEventHash": None,
        "cancellationProof": None,
        "blockProof": None,
        "writerVersion": "provider-lineage-state/1",
    }


def payload_conflict(message: str) -> NoReturn:
    fail("provider-lineage-payload-conflict", message, 73)


def scope_conflict(message: str) -> NoReturn:
    fail("provider-lineage-scope-conflict", message, 75)


def cas_revision(current: dict[str, Any], request: dict[str, Any]) -> None:
    if current["stateRevision"] != request["expectedStateRevision"]:
        fail(
            "provider-lineage-cas-conflict",
            f"expected revision {request['expectedStateRevision']}, current {current['stateRevision']}",
            75,
        )


def consumed(message: str) -> NoReturn:
    fail("provider-lineage-predecessor-consumed", message, 75)


def initialize_transition(
    current: dict[str, Any] | None,
    request: dict[str, Any],
    scope_sha: str,
) -> tuple[dict[str, Any], bool]:
    desired = base_record(request, scope_sha)
    if current is None:
        return desired, True
    if current == desired:
        return current, False
    payload_conflict("scope already has a different initialized checkpoint")


def reserved_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return (
        current["state"] == "reserved_before_start"
        and current["stateRevision"] == request["expectedStateRevision"] + 1
        and current["lineageGeneration"] == request["lineageGeneration"]
        and current["predecessorRunId"] == request["predecessorRunId"]
        and current["predecessorUsageDocumentHash"] == request["predecessorUsageDocumentHash"]
        and current["predecessorCheckpointHash"] == request["predecessorCheckpointHash"]
        and current["reservationId"] == request["reservationId"]
        and current["childRunId"] == request["childRunId"]
    )


def reserve_transition(current: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if reserved_matches(current, request):
        return current, False
    if current["state"] == "reserved_before_start":
        if current["reservationId"] == request["reservationId"]:
            payload_conflict("same reservationId has a different predecessor or child payload")
        scope_conflict("predecessor already has a winning child reservation")
    if current["state"] in {"started", "blocked_after_start"}:
        consumed("predecessor crossed the launch barrier and cannot be reserved again")
    if current["state"] == "cancelled_before_start":
        if current["reservationId"] == request["reservationId"]:
            scope_conflict("cancelled reservationId must be replaced")
        if current["childRunId"] == request["childRunId"]:
            scope_conflict("cancelled childRunId must be replaced")
        expected_generation = current["lineageGeneration"]
    elif current["state"] == "advanced":
        if current["reservationId"] is not None and current["reservationId"] == request["reservationId"]:
            scope_conflict("a completed reservationId cannot be reused by another generation")
        expected_generation = current["lineageGeneration"] + 1
    else:
        scope_conflict(f"state {current['state']} cannot reserve a child")
    cas_revision(current, request)
    if request["lineageGeneration"] != expected_generation:
        scope_conflict(f"reservation must target generation {expected_generation}")
    expected_predecessor = {
        "predecessorRunId": current["predecessorRunId"],
        "predecessorUsageDocumentHash": current["predecessorUsageDocumentHash"],
        "predecessorCheckpointHash": current["predecessorCheckpointHash"],
    }
    for field, expected in expected_predecessor.items():
        if request[field] != expected:
            scope_conflict(f"{field} does not match current advanced checkpoint")
    desired = dict(current)
    desired.update(
        {
            "stateRevision": current["stateRevision"] + 1,
            "lineageGeneration": request["lineageGeneration"],
            "state": "reserved_before_start",
            "reservationId": request["reservationId"],
            "childRunId": request["childRunId"],
            "runnerStartedEventHash": None,
            "cancellationProof": None,
            "blockProof": None,
        }
    )
    return desired, True


def started_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return (
        current["state"] == "started"
        and current["stateRevision"] == request["expectedStateRevision"] + 1
        and current["reservationId"] == request["reservationId"]
        and current["childRunId"] == request["childRunId"]
        and current["runnerStartedEventHash"] == request["runnerStartedEventHash"]
    )


def started_transition(current: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if started_matches(current, request):
        return current, False
    if current["state"] == "started" and current["reservationId"] == request["reservationId"]:
        payload_conflict("same reservation started with a different lifecycle payload")
    if current["state"] in {"advanced", "blocked_after_start"}:
        consumed("started reservation already progressed and predecessor remains consumed")
    if current["state"] != "reserved_before_start":
        scope_conflict(f"state {current['state']} cannot transition to started")
    cas_revision(current, request)
    if current["reservationId"] != request["reservationId"] or current["childRunId"] != request["childRunId"]:
        scope_conflict("started request does not match reserved child")
    desired = dict(current)
    desired.update(
        {
            "stateRevision": current["stateRevision"] + 1,
            "state": "started",
            "runnerStartedEventHash": request["runnerStartedEventHash"],
        }
    )
    return desired, True


def cancelled_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return (
        current["state"] == "cancelled_before_start"
        and current["stateRevision"] == request["expectedStateRevision"] + 1
        and current["reservationId"] == request["reservationId"]
        and current["childRunId"] == request["childRunId"]
        and current["cancellationProof"] == request["cancellationProof"]
    )


def cancel_transition(current: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if cancelled_matches(current, request):
        return current, False
    if current["state"] == "cancelled_before_start" and current["reservationId"] == request["reservationId"]:
        payload_conflict("same cancellation identity has different proof")
    if current["state"] in {"started", "advanced", "blocked_after_start"}:
        consumed("only a never-released reserved child can be cancelled")
    if current["state"] != "reserved_before_start":
        scope_conflict(f"state {current['state']} cannot be cancelled")
    cas_revision(current, request)
    if current["reservationId"] != request["reservationId"] or current["childRunId"] != request["childRunId"]:
        scope_conflict("cancellation does not match reserved child")
    desired = dict(current)
    desired.update(
        {
            "stateRevision": current["stateRevision"] + 1,
            "state": "cancelled_before_start",
            "cancellationProof": request["cancellationProof"],
        }
    )
    return desired, True


def advanced_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return (
        current["state"] == "advanced"
        and current["lineageGeneration"] >= 1
        and current["stateRevision"] == request["expectedStateRevision"] + 1
        and current["reservationId"] == request["reservationId"]
        and current["childRunId"] == request["childRunId"]
        and current["predecessorRunId"] == request["childRunId"]
        and current["predecessorUsageDocumentHash"] == request["usageDocumentHash"]
        and current["predecessorCheckpointHash"] == request["checkpointHash"]
        and current["predecessorRunnerUsageRecordedEventHash"]
        == request["runnerUsageRecordedEventHash"]
        and current["predecessorScopeBoundEventHash"] == request["runnerScopeBoundEventHash"]
    )


def advance_transition(current: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if advanced_matches(current, request):
        return current, False
    if current["state"] == "advanced" and current["reservationId"] == request["reservationId"]:
        payload_conflict("same advance identity has different checkpoint/lifecycle payload")
    if current["state"] == "blocked_after_start":
        consumed("blocked lineage requires operator resolution")
    if current["state"] != "started":
        scope_conflict(f"state {current['state']} cannot advance")
    cas_revision(current, request)
    if current["reservationId"] != request["reservationId"] or current["childRunId"] != request["childRunId"]:
        scope_conflict("advance does not match started child")
    desired = dict(current)
    desired.update(
        {
            "stateRevision": current["stateRevision"] + 1,
            "state": "advanced",
            "predecessorRunId": request["childRunId"],
            "predecessorUsageDocumentHash": request["usageDocumentHash"],
            "predecessorCheckpointHash": request["checkpointHash"],
            "predecessorRunnerUsageRecordedEventHash": request["runnerUsageRecordedEventHash"],
            "predecessorScopeBoundEventHash": request["runnerScopeBoundEventHash"],
            "cancellationProof": None,
            "blockProof": None,
        }
    )
    return desired, True


def blocked_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return (
        current["state"] == "blocked_after_start"
        and current["stateRevision"] == request["expectedStateRevision"] + 1
        and current["reservationId"] == request["reservationId"]
        and current["childRunId"] == request["childRunId"]
        and current["blockProof"] == request["blockProof"]
    )


def block_transition(current: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if blocked_matches(current, request):
        return current, False
    if current["state"] == "blocked_after_start" and current["reservationId"] == request["reservationId"]:
        payload_conflict("same block identity has different evidence")
    if current["state"] == "advanced":
        consumed("advanced lineage cannot be retroactively blocked")
    if current["state"] != "started":
        scope_conflict(f"state {current['state']} cannot be blocked")
    cas_revision(current, request)
    if current["reservationId"] != request["reservationId"] or current["childRunId"] != request["childRunId"]:
        scope_conflict("block request does not match started child")
    desired = dict(current)
    desired.update(
        {
            "stateRevision": current["stateRevision"] + 1,
            "state": "blocked_after_start",
            "blockProof": request["blockProof"],
        }
    )
    return desired, True


TRANSITIONS = {
    "initialize": initialize_transition,
    "reserve": reserve_transition,
    "started": started_transition,
    "advance": advance_transition,
    "cancel": cancel_transition,
    "block": block_transition,
}


def execute_transition(operation: str, control_root: str, request_path: str, contract: Contract) -> dict[str, Any]:
    request = validate_request(operation, read_request(request_path), contract)
    provider = request["provider"]
    thread_id = request["threadId"]
    scope_sha = scope_hash(provider, thread_id, contract)
    provider_dir, provider_fd = store_directory(control_root, provider, True)
    lock_fd = scope_lock(provider_dir, provider_fd, scope_sha, True)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        current, snapshot = maybe_read_record(
            provider_dir,
            provider_fd,
            scope_sha,
            provider,
            thread_id,
            contract,
        )
        if operation != "initialize" and current is None:
            fail("provider-lineage-not-found", "lineage must be initialized before transition", 3)
        test_pause_after_read()
        if operation == "initialize":
            desired, mutate = initialize_transition(current, request, scope_sha)
        else:
            desired, mutate = TRANSITIONS[operation](current, request)
        validate_record(desired, contract)
        if mutate:
            publish_record(
                provider_dir,
                provider_fd,
                scope_sha,
                desired,
                snapshot,
                operation,
                contract,
            )
        else:
            # Повтор может увидеть rename, переживший падение процесса до fsync
            # родительского каталога исходного писателя. До идемпотентного успеха
            # необходимо завершить этот барьер.
            os.fsync(provider_fd)
            trace_step(f"{operation}:idempotent_provider_directory_fsync")
        return desired
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)
            os.close(provider_fd)


def read_lineage(
    control_root: str,
    provider: str,
    thread_id: str,
    contract: Contract,
) -> dict[str, Any]:
    provider, thread_id = validate_provider_scope(provider, thread_id, contract)
    scope_sha = scope_hash(provider, thread_id, contract)
    provider_dir, provider_fd = store_directory(control_root, provider, False)
    try:
        lock_fd = scope_lock(provider_dir, provider_fd, scope_sha, False)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_SH)
            record, _ = read_record_file(
                provider_dir,
                provider_fd,
                scope_sha,
                provider,
                thread_id,
                contract,
            )
            return record
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)
    finally:
        os.close(provider_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--schema", required=True)
    parser.add_argument("operation")
    parser.add_argument("arguments", nargs="*")
    return parser.parse_args()


def require_arguments(args: argparse.Namespace, count: int) -> list[str]:
    if len(args.arguments) != count:
        fail("provider-lineage-argument-invalid", f"{args.operation}: expected {count} arguments", 2)
    return args.arguments


def main() -> int:
    args = parse_args()
    contract = Contract(args.schema)
    if args.operation in TRANSITIONS:
        control_root, request = require_arguments(args, 2)
        record = execute_transition(args.operation, control_root, request, contract)
        sys.stdout.buffer.write(canonical_bytes(record) + b"\n")
    elif args.operation in {"read", "validate"}:
        control_root, provider, thread_id = require_arguments(args, 3)
        record = read_lineage(control_root, provider, thread_id, contract)
        if args.operation == "read":
            sys.stdout.buffer.write(canonical_bytes(record) + b"\n")
    elif args.operation in {"scope-canonical", "scope-hash"}:
        provider, thread_id = require_arguments(args, 2)
        canonical = scope_canonical(provider, thread_id, contract)
        if args.operation == "scope-canonical":
            sys.stdout.buffer.write(canonical + b"\n")
        else:
            print(sha256(canonical))
    else:
        fail("provider-lineage-argument-invalid", f"unknown operation {args.operation!r}", 2)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LineageFailure as error:
        print(f"{error.name}: {error.message}", file=sys.stderr)
        raise SystemExit(error.code)
