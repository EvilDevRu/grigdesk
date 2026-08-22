#!/usr/bin/env python3
"""Строгий устойчивый к сбоям читатель и писатель журнала жизненного цикла попытки хоста."""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from dataclasses import dataclass
from typing import Any, NoReturn


EVENT_LINE_LIMIT = 64 * 1024
JSON_INPUT_LIMIT = 2 * 1024 * 1024
SEGMENT_LIMIT = 256 * 1024 * 1024
DEFAULT_SEGMENT_TARGET = 16 * 1024 * 1024
SAFE_INTEGER = 9_007_199_254_740_991
MANIFEST_KEYS = {
    "schemaVersion",
    "protocolVersion",
    "generation",
    "sealedSegments",
    "activeSegment",
}
TAIL_KEYS = {
    "schemaVersion",
    "protocolVersion",
    "generation",
    "activeSegment",
    "byteLength",
    "sequence",
    "eventHash",
}
SEALED_DESCRIPTOR_KEYS = {
    "name",
    "generation",
    "byteLength",
    "eventCount",
    "firstSequence",
    "lastSequence",
    "basePreviousEventHash",
    "firstEventHash",
    "lastEventHash",
    "contentSha256",
    "previousSegmentSha256",
}
CHAIN_KEYS = {"sequence", "previousEventHash", "eventHash"}
ACTIVE_RE = re.compile(r"^active-([0-9]{16})\.ndjson$")
SEALED_RE = re.compile(r"^sealed-([0-9]{16})\.ndjson$")
SPAN_FAMILIES = {
    "orchestrator_session_started": "orchestrator_session",
    "orchestrator_session_finished": "orchestrator_session",
    "sandbox_started": "sandbox",
    "sandbox_finished": "sandbox",
    "bootstrap_started": "bootstrap",
    "bootstrap_finished": "bootstrap",
    "node_visit_started": "node_visit",
    "node_visit_finished": "node_visit",
    "node_execution_started": "node_execution",
    "node_execution_finished": "node_execution",
    "command_started": "command",
    "command_finished": "command",
    "dispatch_started": "dispatch",
    "dispatch_finished": "dispatch",
    "runner_started": "runner",
    "runner_finished": "runner",
    "runner_abandoned": "runner",
    "gate_wait_started": "gate_wait",
    "gate_decided": "gate_wait",
    "human_intervention_started": "human_intervention",
    "human_intervention_resolved": "human_intervention",
    "cleanup_started": "cleanup",
    "cleanup_finished": "cleanup",
}


class LifecycleFailure(Exception):
    def __init__(self, name: str, message: str, code: int = 78):
        super().__init__(message)
        self.name = name
        self.message = message
        self.code = code


def fail(name: str, message: str, code: int = 78) -> NoReturn:
    raise LifecycleFailure(name, message, code)


def io_fail(message: str) -> NoReturn:
    fail("lifecycle-io-error", message, 1)


def exact_object(value: Any, keys: set[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail("lifecycle-schema-invalid", f"{where}: expected exact keys")
    return value


def _reject_float(value: str) -> NoReturn:
    fail("lifecycle-schema-invalid", f"JSON number {value!r} is outside the safe-integer subset")


def _reject_constant(value: str) -> NoReturn:
    fail("lifecycle-schema-invalid", f"non-JSON number {value!r} is forbidden")


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            fail("lifecycle-schema-invalid", f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def strict_json(data: bytes, where: str) -> Any:
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        fail("lifecycle-schema-invalid", f"{where}: invalid UTF-8 ({error})")
    try:
        return json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
        )
    except LifecycleFailure:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        fail("lifecycle-schema-invalid", f"{where}: invalid JSON ({error})")


def _assert_unicode(value: str, where: str) -> None:
    for char in value:
        if 0xD800 <= ord(char) <= 0xDFFF:
            fail("lifecycle-schema-invalid", f"{where}: unpaired surrogate is forbidden")


@dataclass
class CanonicalBudget:
    values: int = 0


def _canonical(value: Any, budget: CanonicalBudget, where: str, depth: int) -> str:
    budget.values += 1
    if budget.values > 100_000:
        fail("lifecycle-schema-invalid", "canonical JSON exceeds 100000 values")
    if depth > 64:
        fail("lifecycle-schema-invalid", "canonical JSON exceeds depth 64")
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not -SAFE_INTEGER <= value <= SAFE_INTEGER:
            fail("lifecycle-schema-invalid", f"{where}: integer is not IEEE-754 safe")
        return str(value)
    if isinstance(value, float):
        fail("lifecycle-schema-invalid", f"{where}: only safe integer JSON numbers are allowed")
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
                fail("lifecycle-schema-invalid", f"{where}: object key is not a string")
            _assert_unicode(key, f"{where} key")
        # RFC 8785 сортирует имена объектов по кодовым единицам UTF-16, а не по кодовым точкам Unicode.
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "strict"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            + ":"
            + _canonical(value[key], budget, f"{where}.{key}", depth + 1)
            for key in keys
        ) + "}"
    fail("lifecycle-schema-invalid", f"{where}: value is not JSON-safe")


def canonical_bytes(value: Any, limit: int = JSON_INPUT_LIMIT) -> bytes:
    encoded = _canonical(value, CanonicalBudget(), "$", 0).encode("utf-8", "strict")
    if len(encoded) > limit:
        fail("lifecycle-schema-invalid", f"canonical JSON exceeds {limit} bytes")
    return encoded


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_input(path: str, limit: int = JSON_INPUT_LIMIT) -> bytes:
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            fail("lifecycle-schema-invalid", f"{path}: input must be one owned regular file")
        if info.st_size > limit:
            fail("lifecycle-schema-invalid", f"{path}: input exceeds {limit} bytes")
        flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                fail("lifecycle-schema-invalid", f"{path}: input identity changed")
            chunks: list[bytes] = []
            remaining = limit + 1
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > limit:
                fail("lifecycle-schema-invalid", f"{path}: input exceeds {limit} bytes")
            current = os.lstat(path)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                fail("lifecycle-schema-invalid", f"{path}: input path identity changed")
            return data
        finally:
            os.close(descriptor)
    except LifecycleFailure:
        raise
    except OSError as error:
        fail("lifecycle-schema-invalid", f"{path}: cannot read input ({error})")


class Contract:
    def __init__(self, schema_path: str):
        try:
            with open(schema_path, "rb") as source:
                data = source.read(JSON_INPUT_LIMIT + 1)
        except OSError as error:
            fail("lifecycle-schema-invalid", f"cannot read shared schema ({error})")
        if len(data) > JSON_INPUT_LIMIT:
            fail("lifecycle-schema-invalid", "shared schema is too large")
        self.schema = strict_json(data, "shared schema")
        defs = self.schema.get("$defs") if isinstance(self.schema, dict) else None
        properties = self.schema.get("properties") if isinstance(self.schema, dict) else None
        required = self.schema.get("required") if isinstance(self.schema, dict) else None
        if not isinstance(defs, dict) or not isinstance(properties, dict) or not isinstance(required, list):
            fail("lifecycle-schema-invalid", "shared schema shape is incompatible")
        self.defs = defs
        self.properties = properties
        self.event_keys = set(required)
        if self.event_keys != set(properties):
            fail("lifecycle-schema-invalid", "shared envelope properties/required drift")
        self.draft_keys = self.event_keys - CHAIN_KEYS
        self.kinds = set(self._definition("lifecycleKind").get("enum", []))
        self.clock_fidelity = set(self._definition("clockFidelity").get("enum", []))
        self.visit_reasons = set(self._definition("visitReason").get("enum", []))
        self.execution_reasons = set(self._definition("executionReason").get("enum", []))
        self.run_reasons = set(self._definition("runReason").get("enum", []))
        if not self.kinds or not self.clock_fidelity:
            fail("lifecycle-schema-invalid", "shared enums are empty")
        if self.properties.get("schemaVersion", {}).get("const") != 1:
            fail("lifecycle-schema-invalid", "unsupported schemaVersion contract")
        if self.properties.get("protocolVersion", {}).get("const") != 2:
            fail("lifecycle-schema-invalid", "unsupported protocolVersion contract")

    def validate(self, value: Any) -> None:
        errors = self._schema_errors(value, self.schema, "$")
        if errors:
            fail("lifecycle-schema-invalid", errors[0])

    def _resolve(self, reference: Any, where: str) -> dict[str, Any]:
        if not isinstance(reference, str) or not reference.startswith("#/$defs/"):
            fail("lifecycle-schema-invalid", f"{where}: unsupported schema reference")
        return self._definition(reference.removeprefix("#/$defs/"))

    @staticmethod
    def _has_type(value: Any, expected: str) -> bool:
        if expected == "null":
            return value is None
        if expected == "boolean":
            return isinstance(value, bool)
        if expected == "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        if expected == "string":
            return isinstance(value, str)
        if expected == "array":
            return isinstance(value, list)
        if expected == "object":
            return isinstance(value, dict)
        fail("lifecycle-schema-invalid", f"shared schema uses unsupported type {expected!r}")

    def _schema_errors(
        self,
        value: Any,
        schema: Any,
        where: str,
        *,
        stop_after: int = 8,
    ) -> list[str]:
        if not isinstance(schema, dict):
            fail("lifecycle-schema-invalid", f"shared schema at {where} is not an object")
        if "$ref" in schema:
            return self._schema_errors(value, self._resolve(schema["$ref"], where), where)
        errors: list[str] = []
        expected_type = schema.get("type")
        if expected_type is not None:
            if not isinstance(expected_type, str):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has unsupported type union")
            if not self._has_type(value, expected_type):
                return [f"{where}: expected {expected_type}"]
        if "const" in schema and canonical_bytes(value) != canonical_bytes(schema["const"]):
            errors.append(f"{where}: value does not match const")
        choices = schema.get("enum")
        if choices is not None:
            if not isinstance(choices, list):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid enum")
            encoded_value = canonical_bytes(value)
            if not any(encoded_value == canonical_bytes(choice) for choice in choices):
                errors.append(f"{where}: value is outside the closed enum")
        if isinstance(value, str):
            minimum_length = schema.get("minLength")
            maximum_length = schema.get("maxLength")
            if minimum_length is not None and len(value) < minimum_length:
                errors.append(f"{where}: string is shorter than {minimum_length}")
            if maximum_length is not None and len(value) > maximum_length:
                errors.append(f"{where}: string is longer than {maximum_length}")
            pattern = schema.get("pattern")
            if pattern is not None:
                if not isinstance(pattern, str):
                    fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid pattern")
                try:
                    matched = re.search(pattern, value) is not None
                except re.error as error:
                    fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid pattern ({error})")
                if not matched:
                    errors.append(f"{where}: string does not match the required pattern")
        if isinstance(value, int) and not isinstance(value, bool):
            minimum = schema.get("minimum")
            maximum = schema.get("maximum")
            if minimum is not None and value < minimum:
                errors.append(f"{where}: integer is below {minimum}")
            if maximum is not None and value > maximum:
                errors.append(f"{where}: integer is above {maximum}")
        if isinstance(value, list):
            minimum_items = schema.get("minItems")
            maximum_items = schema.get("maxItems")
            if minimum_items is not None and len(value) < minimum_items:
                errors.append(f"{where}: array has fewer than {minimum_items} items")
            if maximum_items is not None and len(value) > maximum_items:
                errors.append(f"{where}: array has more than {maximum_items} items")
            if schema.get("uniqueItems") is True:
                encoded = [canonical_bytes(item) for item in value]
                if len(set(encoded)) != len(encoded):
                    errors.append(f"{where}: array items are not unique")
            item_schema = schema.get("items")
            if item_schema is not None:
                for index, item in enumerate(value):
                    errors.extend(self._schema_errors(item, item_schema, f"{where}[{index}]"))
                    if len(errors) >= stop_after:
                        return errors
        if isinstance(value, dict):
            required = schema.get("required", [])
            if not isinstance(required, list) or any(not isinstance(key, str) for key in required):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid required")
            for key in required:
                if key not in value:
                    errors.append(f"{where}: missing required property {key!r}")
            properties = schema.get("properties", {})
            if not isinstance(properties, dict):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid properties")
            for key, item in value.items():
                if key in properties:
                    errors.extend(self._schema_errors(item, properties[key], f"{where}.{key}"))
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{where}: unknown property {key!r}")
                if len(errors) >= stop_after:
                    return errors
        all_of = schema.get("allOf")
        if all_of is not None:
            if not isinstance(all_of, list):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid allOf")
            for branch in all_of:
                errors.extend(self._schema_errors(value, branch, where))
                if len(errors) >= stop_after:
                    return errors
        one_of = schema.get("oneOf")
        if one_of is not None:
            if not isinstance(one_of, list):
                fail("lifecycle-schema-invalid", f"shared schema at {where} has invalid oneOf")
            matches_count = sum(not self._schema_errors(value, branch, where) for branch in one_of)
            if matches_count != 1:
                errors.append(f"{where}: expected exactly one discriminated schema branch")
        condition = schema.get("if")
        if condition is not None:
            selected = schema.get("then") if not self._schema_errors(value, condition, where) else schema.get("else")
            if selected is not None:
                errors.extend(self._schema_errors(value, selected, where))
        return errors[:stop_after]

    def _definition(self, name: str) -> dict[str, Any]:
        value = self.defs.get(name)
        if not isinstance(value, dict):
            fail("lifecycle-schema-invalid", f"shared schema misses $defs.{name}")
        return value

    def pattern(self, name: str) -> re.Pattern[str]:
        pattern = self._definition(name).get("pattern")
        if not isinstance(pattern, str):
            fail("lifecycle-schema-invalid", f"shared schema misses pattern for {name}")
        return re.compile(pattern)

    def nested_pattern(self, name: str) -> re.Pattern[str]:
        choices = self._definition(name).get("oneOf")
        if not isinstance(choices, list):
            fail("lifecycle-schema-invalid", f"shared schema misses union for {name}")
        for choice in choices:
            if isinstance(choice, dict) and isinstance(choice.get("pattern"), str):
                return re.compile(choice["pattern"])
            if isinstance(choice, dict) and isinstance(choice.get("$ref"), str):
                target = choice["$ref"].rsplit("/", 1)[-1]
                definition = self._definition(target)
                if isinstance(definition.get("pattern"), str):
                    return re.compile(definition["pattern"])
        fail("lifecycle-schema-invalid", f"shared schema misses non-null pattern for {name}")


def matches(pattern: re.Pattern[str], value: Any, where: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        fail("lifecycle-schema-invalid", f"{where}: invalid value")
    return value


def nullable_matches(pattern: re.Pattern[str], value: Any, where: str) -> None:
    if value is not None:
        matches(pattern, value, where)


def safe_integer(value: Any, where: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= SAFE_INTEGER:
        fail("lifecycle-schema-invalid", f"{where}: expected safe integer >= {minimum}")
    return value


def validate_timestamp(value: Any, contract: Contract) -> None:
    matches(contract.pattern("utcMilliseconds"), value, "at")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        fail("lifecycle-schema-invalid", f"at: invalid UTC timestamp ({error})")
    if parsed.microsecond % 1000:
        fail("lifecycle-schema-invalid", "at: timestamp must have exact milliseconds")


def validate_event(value: Any, contract: Contract, *, draft: bool) -> dict[str, Any]:
    keys = contract.draft_keys if draft else contract.event_keys
    event = exact_object(value, keys, "event draft" if draft else "event")
    schema_event = dict(event)
    if draft:
        schema_event.update(
            sequence=1,
            previousEventHash=None,
            eventHash="0" * 64,
        )
    contract.validate(schema_event)
    validate_timestamp(event["at"], contract)
    if (event["routeId"] is None) != (event["routeHash"] is None):
        fail("lifecycle-schema-invalid", "routeId and routeHash must become non-null together")
    kind = event["kind"]
    if draft:
        if kind == "lifecycle_tail_recovered":
            fail("lifecycle-schema-invalid", "recovery events are writer-owned")
    canonical_bytes(event, EVENT_LINE_LIMIT)
    return event


def event_hash(event: dict[str, Any]) -> str:
    if "eventHash" not in event:
        fail("lifecycle-schema-invalid", "eventHash is missing")
    preimage = dict(event)
    del preimage["eventHash"]
    return sha256(canonical_bytes(preimage, EVENT_LINE_LIMIT))


def seal_event(
    draft: dict[str, Any], sequence: int, previous_hash: str | None, contract: Contract
) -> tuple[dict[str, Any], bytes]:
    event = dict(draft)
    event["sequence"] = sequence
    event["previousEventHash"] = previous_hash
    event["eventHash"] = "0" * 64
    event["eventHash"] = event_hash(event)
    validate_event(event, contract, draft=False)
    line = canonical_bytes(event, EVENT_LINE_LIMIT) + b"\n"
    if len(line) > EVENT_LINE_LIMIT:
        fail("lifecycle-schema-invalid", f"event line exceeds {EVENT_LINE_LIMIT} bytes")
    return event, line


def secure_directory(path: str) -> int:
    try:
        info = os.lstat(path)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            fail("lifecycle-filesystem-invalid", f"{path}: expected owned directory mode 0700")
        if os.path.realpath(path) != path:
            fail("lifecycle-filesystem-invalid", f"{path}: non-canonical directory path")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
            or (opened.st_dev, opened.st_ino, opened.st_ctime_ns)
            != (info.st_dev, info.st_ino, info.st_ctime_ns)
        ):
            os.close(descriptor)
            fail("lifecycle-filesystem-invalid", f"{path}: directory identity changed")
        return descriptor
    except LifecycleFailure:
        raise
    except OSError as error:
        fail("lifecycle-filesystem-invalid", f"{path}: unsafe directory ({error})")


@dataclass(frozen=True)
class StateFileSnapshot:
    dev: int
    ino: int
    size: int
    mtime_ns: int
    digest: str


def secure_state_file_snapshot(
    path: str,
    limit: int,
    *,
    mode: int = 0o600,
) -> tuple[bytes, StateFileSnapshot]:
    try:
        info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != mode
        ):
            fail(
                "lifecycle-filesystem-invalid",
                f"{path}: expected owned regular file mode {mode:04o} nlink=1",
            )
        if info.st_size > limit:
            fail("lifecycle-corruption", f"{path}: file exceeds {limit} bytes")
        flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_uid != os.geteuid()
                or opened.st_nlink != 1
                or stat.S_IMODE(opened.st_mode) != mode
                or (
                    opened.st_dev,
                    opened.st_ino,
                    opened.st_size,
                    opened.st_mtime_ns,
                    opened.st_ctime_ns,
                )
                != (
                    info.st_dev,
                    info.st_ino,
                    info.st_size,
                    info.st_mtime_ns,
                    info.st_ctime_ns,
                )
            ):
                fail("lifecycle-filesystem-invalid", f"{path}: file identity changed")
            chunks: list[bytes] = []
            remaining = limit + 1
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > limit:
                fail("lifecycle-corruption", f"{path}: file exceeds {limit} bytes")
            after = os.fstat(descriptor)
            if (
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ) != (
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            ):
                fail("lifecycle-filesystem-invalid", f"{path}: file changed while reading")
            current = os.lstat(path)
            if (
                current.st_dev,
                current.st_ino,
                current.st_size,
                current.st_mtime_ns,
                current.st_ctime_ns,
            ) != (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            ):
                fail("lifecycle-filesystem-invalid", f"{path}: file path identity changed")
            return data, StateFileSnapshot(
                dev=opened.st_dev,
                ino=opened.st_ino,
                size=opened.st_size,
                mtime_ns=opened.st_mtime_ns,
                digest=sha256(data),
            )
        finally:
            os.close(descriptor)
    except FileNotFoundError:
        fail("lifecycle-not-initialized", f"{path}: file is missing", 3)
    except LifecycleFailure:
        raise
    except OSError as error:
        fail("lifecycle-filesystem-invalid", f"{path}: unsafe file ({error})")


def secure_state_file(path: str, limit: int, *, mode: int = 0o600) -> bytes:
    return secure_state_file_snapshot(path, limit, mode=mode)[0]


def _write_all(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            io_fail("short write while publishing lifecycle state")
        offset += written


def _temp_path(directory: str, prefix: str) -> tuple[str, int]:
    for _ in range(128):
        path = os.path.join(directory, f".{prefix}.{secrets.token_hex(12)}.tmp")
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags, 0o600)
            os.fchmod(descriptor, 0o600)
            return path, descriptor
        except FileExistsError:
            continue
        except OSError as error:
            io_fail(f"cannot create lifecycle temp file ({error})")
    io_fail("cannot allocate lifecycle temp file")


def _fsync_directory(path: str) -> None:
    descriptor = secure_directory(path)
    try:
        os.fsync(descriptor)
    except OSError as error:
        io_fail(f"cannot fsync directory {path} ({error})")
    finally:
        os.close(descriptor)


def trace_step(step: str) -> None:
    trace = os.environ.get("ATTEMPT_LIFECYCLE_TRACE_FILE")
    if trace and os.environ.get("FACTORY_TESTING") == "1":
        try:
            descriptor = os.open(trace, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC, 0o600)
            try:
                _write_all(descriptor, (step + "\n").encode("utf-8"))
            finally:
                os.close(descriptor)
        except OSError:
            pass
    if (
        os.environ.get("FACTORY_TESTING") == "1"
        and os.environ.get("ATTEMPT_LIFECYCLE_FAIL_AFTER") == step
    ):
        os._exit(91)


def publish_replace(
    directory: str,
    name: str,
    data: bytes,
    *,
    context: str,
    file_step: str,
    rename_step: str | None = None,
    directory_step: str,
) -> None:
    temp, descriptor = _temp_path(directory, name)
    try:
        _write_all(descriptor, data)
        os.fsync(descriptor)
        trace_step(f"{context}:{file_step}")
    except BaseException:
        os.close(descriptor)
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
    else:
        os.close(descriptor)
    target = os.path.join(directory, name)
    try:
        os.replace(temp, target)
        if rename_step:
            trace_step(f"{context}:{rename_step}")
        _fsync_directory(directory)
        trace_step(f"{context}:{directory_step}")
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def _rename_noreplace(source: str, target: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            -100,
            os.fsencode(source),
            -100,
            os.fsencode(target),
            1,
        )
        if result == 0:
            return
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise FileExistsError(error_number, os.strerror(error_number), target)
        if error_number not in (errno.ENOSYS, errno.EINVAL):
            raise OSError(error_number, os.strerror(error_number), target)
    os.link(source, target, follow_symlinks=False)
    os.unlink(source)


def publish_if_absent(
    directory: str,
    name: str,
    data: bytes,
    *,
    mode: int,
    context: str,
    file_step: str,
    directory_step: str | None = None,
) -> None:
    target = os.path.join(directory, name)
    if os.path.lexists(target):
        existing = secure_state_file(target, max(len(data), EVENT_LINE_LIMIT), mode=mode)
        if existing != data:
            fail("lifecycle-generation-conflict", f"{name}: existing generation has different bytes")
        descriptor = os.open(target, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        trace_step(f"{context}:{file_step}")
    else:
        temp, descriptor = _temp_path(directory, name)
        try:
            os.fchmod(descriptor, mode)
            _write_all(descriptor, data)
            os.fsync(descriptor)
            trace_step(f"{context}:{file_step}")
        except BaseException:
            os.close(descriptor)
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise
        else:
            os.close(descriptor)
        try:
            _rename_noreplace(temp, target)
        except FileExistsError:
            try:
                os.unlink(temp)
            except OSError:
                pass
            existing = secure_state_file(target, max(len(data), EVENT_LINE_LIMIT), mode=mode)
            if existing != data:
                fail("lifecycle-generation-conflict", f"{name}: concurrent generation has different bytes")
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise
    if directory_step is not None:
        _fsync_directory(directory)
        trace_step(f"{context}:{directory_step}")


def publish_manifest_cas(
    lifecycle: str,
    data: bytes,
    expected: StateFileSnapshot | None,
    *,
    context: str,
) -> None:
    temp, descriptor = _temp_path(lifecycle, "manifest.json")
    try:
        _write_all(descriptor, data)
        os.fsync(descriptor)
        trace_step(f"{context}:manifest_temp_fsync")
    except BaseException:
        os.close(descriptor)
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
    else:
        os.close(descriptor)
    target = os.path.join(lifecycle, "manifest.json")
    try:
        if expected is None:
            if os.path.lexists(target):
                fail("lifecycle-manifest-conflict", "initial manifest appeared before publication")
        else:
            _, current = secure_state_file_snapshot(target, JSON_INPUT_LIMIT)
            if current != expected:
                fail("lifecycle-manifest-conflict", "manifest changed after the selected generation was read")
        trace_step(f"{context}:manifest_cas")
        if expected is None:
            _rename_noreplace(temp, target)
        else:
            os.replace(temp, target)
        trace_step(f"{context}:manifest_rename")
        _fsync_directory(lifecycle)
        trace_step(f"{context}:lifecycle_directory_fsync")
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def load_manifest(lifecycle: str) -> tuple[dict[str, Any], StateFileSnapshot]:
    path = os.path.join(lifecycle, "manifest.json")
    raw, snapshot = secure_state_file_snapshot(path, JSON_INPUT_LIMIT)
    manifest = exact_object(strict_json(raw, "manifest"), MANIFEST_KEYS, "manifest")
    if canonical_bytes(manifest, JSON_INPUT_LIMIT) + b"\n" != raw:
        fail("lifecycle-corruption", "manifest is not one canonical JSON line")
    if manifest["schemaVersion"] != 1 or manifest["protocolVersion"] != 2:
        fail("lifecycle-corruption", "manifest version is unsupported")
    generation = safe_integer(manifest["generation"], "manifest.generation", 1)
    active = manifest["activeSegment"]
    active_match = ACTIVE_RE.fullmatch(active) if isinstance(active, str) else None
    if active_match is None or int(active_match.group(1)) != generation:
        fail("lifecycle-corruption", "manifest active generation is inconsistent")
    sealed = manifest["sealedSegments"]
    if not isinstance(sealed, list) or len(sealed) > 4096:
        fail("lifecycle-corruption", "manifest sealedSegments is not an ordered unique list")
    seen_names: set[str] = set()
    previous = 0
    previous_digest: str | None = None
    for index, raw_descriptor in enumerate(sealed):
        descriptor = exact_object(
            raw_descriptor,
            SEALED_DESCRIPTOR_KEYS,
            f"manifest.sealedSegments[{index}]",
        )
        name = descriptor["name"]
        match = SEALED_RE.fullmatch(name) if isinstance(name, str) else None
        if match is None:
            fail("lifecycle-corruption", "manifest contains an invalid sealed segment name")
        current = int(match.group(1))
        if (
            current <= previous
            or current >= generation
            or descriptor["generation"] != current
            or name in seen_names
        ):
            fail("lifecycle-corruption", "manifest sealed generations are not strictly ordered")
        safe_integer(descriptor["byteLength"], f"sealed[{index}].byteLength", 1)
        if descriptor["byteLength"] > SEGMENT_LIMIT:
            fail("lifecycle-corruption", "manifest sealed segment exceeds the hard byte limit")
        safe_integer(descriptor["eventCount"], f"sealed[{index}].eventCount", 1)
        first_sequence = safe_integer(descriptor["firstSequence"], f"sealed[{index}].firstSequence", 1)
        last_sequence = safe_integer(descriptor["lastSequence"], f"sealed[{index}].lastSequence", 1)
        if last_sequence - first_sequence + 1 != descriptor["eventCount"]:
            fail("lifecycle-corruption", "manifest sealed event range/count mismatch")
        nullable_matches(
            re.compile(r"^[a-f0-9]{64}$"),
            descriptor["basePreviousEventHash"],
            f"sealed[{index}].basePreviousEventHash",
        )
        for key in ("firstEventHash", "lastEventHash", "contentSha256"):
            matches(re.compile(r"^[a-f0-9]{64}$"), descriptor[key], f"sealed[{index}].{key}")
        nullable_matches(
            re.compile(r"^[a-f0-9]{64}$"),
            descriptor["previousSegmentSha256"],
            f"sealed[{index}].previousSegmentSha256",
        )
        if descriptor["previousSegmentSha256"] != previous_digest:
            fail("lifecycle-corruption", "manifest sealed segment hash chain is broken")
        previous_digest = descriptor["contentSha256"]
        seen_names.add(name)
        previous = current
    return manifest, snapshot


@dataclass
class Ledger:
    manifest: dict[str, Any]
    manifest_snapshot: StateFileSnapshot
    events: list[dict[str, Any]]
    lines: list[bytes]
    active_events: list[dict[str, Any]]
    active_lines: list[bytes]
    active_bytes: bytes
    active_snapshot: StateFileSnapshot
    valid_active_bytes: bytes
    torn_bytes: bytes
    last_hash: str | None
    last_sequence: int


def parse_event_line(
    line: bytes,
    contract: Contract,
    task_id: str,
    attempt_id: str,
    expected_sequence: int,
    previous_hash: str | None,
    where: str,
) -> dict[str, Any]:
    if not line.endswith(b"\n") or len(line) > EVENT_LINE_LIMIT:
        fail("lifecycle-corruption", f"{where}: invalid lifecycle line boundary/size")
    body = line[:-1]
    if not body:
        fail("lifecycle-corruption", f"{where}: empty event line")
    try:
        event = validate_event(strict_json(body, where), contract, draft=False)
    except LifecycleFailure as error:
        fail("lifecycle-corruption", f"{where}: {error.name}: {error.message}")
    if canonical_bytes(event, EVENT_LINE_LIMIT) != body:
        fail("lifecycle-corruption", f"{where}: event line is not RFC 8785 canonical")
    if event_hash(event) != event["eventHash"]:
        fail("lifecycle-corruption", f"{where}: eventHash mismatch")
    if event["sequence"] != expected_sequence:
        fail("lifecycle-corruption", f"{where}: non-monotonic sequence")
    if event["previousEventHash"] != previous_hash:
        fail("lifecycle-corruption", f"{where}: previousEventHash mismatch")
    if event["taskId"] != task_id or event["attemptId"] != attempt_id:
        fail("lifecycle-corruption", f"{where}: event identity does not match attempt path")
    return event


def validate_identity_sequence(events: list[dict[str, Any]], *, stored: bool) -> None:
    if not events:
        return
    failure_name = "lifecycle-corruption" if stored else "lifecycle-schema-invalid"

    def identity_fail(message: str) -> NoReturn:
        fail(failure_name, message)

    profile = events[0]["profile"]
    route: tuple[str, str] | None = None
    entity_maps: dict[str, dict[Any, tuple[Any, ...]]] = {
        "nodeVisitId": {},
        "nodeExecutionId": {},
        "dispatchId": {},
        "run": {},
        "spanId": {},
    }
    for event in events:
        location = f"sequence {event['sequence']}" if "sequence" in event else f"eventId {event['eventId']}"
        if event["profile"] != profile:
            identity_fail(f"{location}: immutable attempt profile changed")
        event_route = (
            (event["routeId"], event["routeHash"])
            if event["routeId"] is not None
            else None
        )
        if route is None:
            if event["kind"] == "route_selected":
                if event_route is None:
                    identity_fail(f"{location}: route_selected does not carry its pin")
                route = event_route
            elif event_route is not None:
                identity_fail(f"{location}: scoped route identity appears before route_selected")
        else:
            if event["kind"] == "route_selected":
                identity_fail(f"{location}: immutable route was selected more than once")
            if event_route != route:
                identity_fail(f"{location}: route identity drifted after route pin")

        scopes: list[tuple[str, Any, tuple[Any, ...]]] = []
        if event["nodeVisitId"] is not None:
            scopes.append((
                "nodeVisitId",
                event["nodeVisitId"],
                (event["routeId"], event["routeHash"], event["nodeId"], event["runKey"]),
            ))
        if event["nodeExecutionId"] is not None:
            scopes.append((
                "nodeExecutionId",
                event["nodeExecutionId"],
                (
                    event["routeId"], event["routeHash"], event["nodeVisitId"],
                    event["nodeId"], event["runKey"],
                ),
            ))
        if event["dispatchId"] is not None:
            scopes.append((
                "dispatchId",
                event["dispatchId"],
                (
                    event["routeId"], event["routeHash"], event["nodeVisitId"],
                    event["nodeExecutionId"], event["nodeId"], event["runKey"],
                ),
            ))
        if event["runId"] is not None:
            scopes.append((
                "run",
                (event["runId"], event["epoch"]),
                (
                    event["routeId"], event["routeHash"], event["nodeVisitId"],
                    event["nodeExecutionId"], event["nodeId"], event["runKey"],
                    event["dispatchId"],
                ),
            ))
        if event["spanId"] is not None:
            span_family = SPAN_FAMILIES[event["kind"]]
            # Спаны уровня попытки законно пересекают одноразовое закрепление маршрута.
            # Ожидания ворот/человека (и содержащий их визит ворот) законно пересекают
            # границу процесса оркестратора; их стабильная идентичность визита/спана
            # остаётся источником истины, а оболочка фиксирует сессию, записавшую
            # каждую границу.
            span_route = (
                (None, None)
                if span_family in {"orchestrator_session", "sandbox", "bootstrap", "cleanup"}
                else (event["routeId"], event["routeHash"])
            )
            span_session = (
                None
                if span_family in {"node_visit", "gate_wait", "human_intervention"}
                else event["orchestratorSessionId"]
            )
            scopes.append((
                "spanId",
                event["spanId"],
                (
                    span_family, *span_route,
                    span_session, event["nodeVisitId"],
                    event["nodeExecutionId"], event["nodeId"], event["runKey"],
                    event["dispatchId"], event["runId"], event["epoch"],
                ),
            ))
        for scope_name, scope_id, identity in scopes:
            previous = entity_maps[scope_name].setdefault(scope_id, identity)
            if previous != identity:
                identity_fail(f"{location}: {scope_name} was reused with different parent identity")


def load_ledger(lifecycle: str, task_id: str, attempt_id: str, contract: Contract) -> Ledger:
    manifest, manifest_snapshot = load_manifest(lifecycle)
    segments_dir = os.path.join(lifecycle, "segments")
    events: list[dict[str, Any]] = []
    lines: list[bytes] = []
    seen_ids: set[str] = set()
    previous_hash: str | None = None
    expected_sequence = 1
    active_bytes = b""
    active_snapshot: StateFileSnapshot | None = None
    valid_active = b""
    torn = b""
    active_events: list[dict[str, Any]] = []
    active_lines: list[bytes] = []
    selected = [(descriptor["name"], descriptor) for descriptor in manifest["sealedSegments"]]
    selected.append((manifest["activeSegment"], None))
    for name, descriptor in selected:
        sealed = descriptor is not None
        path = os.path.join(segments_dir, name)
        raw, segment_snapshot = secure_state_file_snapshot(
            path,
            SEGMENT_LIMIT,
            mode=0o400 if sealed else 0o600,
        )
        if sealed:
            if not raw or not raw.endswith(b"\n"):
                fail("lifecycle-corruption", f"{name}: sealed segment has an incomplete tail")
            prefix = raw
            remainder = b""
        elif raw and not raw.endswith(b"\n"):
            boundary = raw.rfind(b"\n")
            valid_length = boundary + 1 if boundary >= 0 else 0
            prefix = raw[:valid_length]
            remainder = raw[valid_length:]
        else:
            prefix = raw
            remainder = b""
        offset = 0
        segment_events: list[dict[str, Any]] = []
        segment_lines: list[bytes] = []
        base_previous_hash = previous_hash
        for line in prefix.splitlines(keepends=True):
            where = f"{name}@{offset}"
            event = parse_event_line(
                line,
                contract,
                task_id,
                attempt_id,
                expected_sequence,
                previous_hash,
                where,
            )
            if event["eventId"] in seen_ids:
                fail("lifecycle-corruption", f"{where}: duplicate stable eventId")
            seen_ids.add(event["eventId"])
            events.append(event)
            lines.append(line)
            segment_events.append(event)
            segment_lines.append(line)
            previous_hash = event["eventHash"]
            expected_sequence += 1
            offset += len(line)
        if sealed:
            assert descriptor is not None
            if not segment_events:
                fail("lifecycle-corruption", f"{name}: sealed segment is empty")
            observed = {
                "name": name,
                "generation": int(SEALED_RE.fullmatch(name).group(1)),
                "byteLength": len(raw),
                "eventCount": len(segment_events),
                "firstSequence": segment_events[0]["sequence"],
                "lastSequence": segment_events[-1]["sequence"],
                "basePreviousEventHash": base_previous_hash,
                "firstEventHash": segment_events[0]["eventHash"],
                "lastEventHash": segment_events[-1]["eventHash"],
                "contentSha256": sha256(raw),
                "previousSegmentSha256": descriptor["previousSegmentSha256"],
            }
            if observed != descriptor:
                fail("lifecycle-corruption", f"{name}: sealed descriptor does not match exact bytes")
        else:
            active_bytes = raw
            active_snapshot = segment_snapshot
            valid_active = prefix
            torn = remainder
            active_events = segment_events
            active_lines = segment_lines
    if active_snapshot is None:
        fail("lifecycle-corruption", "manifest does not select an active segment")
    validate_identity_sequence(events, stored=True)
    return Ledger(
        manifest=manifest,
        manifest_snapshot=manifest_snapshot,
        events=events,
        lines=lines,
        active_events=active_events,
        active_lines=active_lines,
        active_bytes=active_bytes,
        active_snapshot=active_snapshot,
        valid_active_bytes=valid_active,
        torn_bytes=torn,
        last_hash=previous_hash,
        last_sequence=expected_sequence - 1,
    )


def make_manifest(generation: int, sealed: list[dict[str, Any]], active: str) -> bytes:
    value = {
        "schemaVersion": 1,
        "protocolVersion": 2,
        "generation": generation,
        "sealedSegments": sealed,
        "activeSegment": active,
    }
    return canonical_bytes(value, JSON_INPUT_LIMIT) + b"\n"


def make_sealed_descriptor(ledger: Ledger) -> dict[str, Any]:
    if ledger.torn_bytes or not ledger.active_events or ledger.valid_active_bytes != ledger.active_bytes:
        fail("lifecycle-corruption", "only a complete non-empty active segment can be sealed")
    generation = ledger.manifest["generation"]
    descriptor = {
        "name": f"sealed-{generation:016d}.ndjson",
        "generation": generation,
        "byteLength": len(ledger.active_bytes),
        "eventCount": len(ledger.active_events),
        "firstSequence": ledger.active_events[0]["sequence"],
        "lastSequence": ledger.active_events[-1]["sequence"],
        "basePreviousEventHash": ledger.active_events[0]["previousEventHash"],
        "firstEventHash": ledger.active_events[0]["eventHash"],
        "lastEventHash": ledger.active_events[-1]["eventHash"],
        "contentSha256": sha256(ledger.active_bytes),
        "previousSegmentSha256": (
            ledger.manifest["sealedSegments"][-1]["contentSha256"]
            if ledger.manifest["sealedSegments"]
            else None
        ),
    }
    if set(descriptor) != SEALED_DESCRIPTOR_KEYS:
        io_fail("internal sealed descriptor drift")
    return descriptor


def assert_active_unchanged(lifecycle: str, ledger: Ledger) -> None:
    path = os.path.join(lifecycle, "segments", ledger.manifest["activeSegment"])
    _, current = secure_state_file_snapshot(path, SEGMENT_LIMIT)
    if current != ledger.active_snapshot:
        fail("lifecycle-manifest-conflict", "active segment changed after the selected generation was read")


def write_tail(lifecycle: str, ledger: Ledger, *, context: str) -> None:
    active_path = os.path.join(lifecycle, "segments", ledger.manifest["activeSegment"])
    active_size = len(secure_state_file(active_path, SEGMENT_LIMIT))
    value = {
        "schemaVersion": 1,
        "protocolVersion": 2,
        "generation": ledger.manifest["generation"],
        "activeSegment": ledger.manifest["activeSegment"],
        "byteLength": active_size,
        "sequence": ledger.last_sequence,
        "eventHash": ledger.last_hash,
    }
    if set(value) != TAIL_KEYS:
        io_fail("internal tail schema drift")
    publish_replace(
        lifecycle,
        "tail.json",
        canonical_bytes(value, EVENT_LINE_LIMIT) + b"\n",
        context=context,
        file_step="tail_temp_fsync",
        rename_step="tail_rename",
        directory_step="lifecycle_directory_fsync",
    )


def initialize(attempt_dir: str, task_id: str, attempt_id: str, contract: Contract) -> None:
    validate_path_identity(attempt_dir, task_id, attempt_id, contract)
    attempt_fd = secure_directory(attempt_dir)
    lifecycle = os.path.join(attempt_dir, "lifecycle")
    try:
        try:
            os.mkdir("lifecycle", 0o700, dir_fd=attempt_fd)
            os.fsync(attempt_fd)
        except FileExistsError:
            pass
    finally:
        os.close(attempt_fd)
    lifecycle_fd = secure_directory(lifecycle)
    try:
        fcntl.flock(lifecycle_fd, fcntl.LOCK_EX)
        created_child = False
        for name in ("segments", "quarantine", "usage"):
            path = os.path.join(lifecycle, name)
            try:
                os.mkdir(name, 0o700, dir_fd=lifecycle_fd)
                created_child = True
            except FileExistsError:
                pass
            child_fd = secure_directory(path)
            os.close(child_fd)
        if created_child:
            os.fsync(lifecycle_fd)
        manifest_path = os.path.join(lifecycle, "manifest.json")
        if os.path.lexists(manifest_path):
            ledger = load_ledger(lifecycle, task_id, attempt_id, contract)
            if ledger.torn_bytes:
                fail("lifecycle-incomplete", "active segment has a torn tail", 74)
            write_tail(lifecycle, ledger, context="init-existing")
            return
        generation = 1
        active = f"active-{generation:016d}.ndjson"
        segments = os.path.join(lifecycle, "segments")
        publish_if_absent(
            segments,
            active,
            b"",
            mode=0o600,
            context="init",
            file_step="segment_fsync",
            directory_step="segments_directory_fsync",
        )
        publish_manifest_cas(
            lifecycle,
            make_manifest(generation, [], active),
            None,
            context="init",
        )
        ledger = load_ledger(lifecycle, task_id, attempt_id, contract)
        write_tail(lifecycle, ledger, context="init")
    finally:
        try:
            fcntl.flock(lifecycle_fd, fcntl.LOCK_UN)
        finally:
            os.close(lifecycle_fd)


def validate_path_identity(attempt_dir: str, task_id: str, attempt_id: str, contract: Contract) -> None:
    matches(contract.pattern("taskId"), task_id, "taskId")
    matches(contract.pattern("attemptId"), attempt_id, "attemptId")
    normalized = os.path.abspath(attempt_dir)
    if normalized != attempt_dir or os.path.realpath(attempt_dir) != attempt_dir:
        fail("lifecycle-filesystem-invalid", "attempt path is not canonical")
    if os.path.basename(attempt_dir) != attempt_id:
        fail("lifecycle-filesystem-invalid", "attempt path does not match attemptId")
    attempts_dir = os.path.dirname(attempt_dir)
    if os.path.basename(attempts_dir) != "attempts" or os.path.basename(os.path.dirname(attempts_dir)) != task_id:
        fail("lifecycle-filesystem-invalid", "attempt path does not match taskId")


def recovery_draft(
    ledger: Ledger,
    pending: dict[str, Any],
    source_hash: str,
    contract: Contract,
) -> dict[str, Any]:
    base = ledger.events[-1] if ledger.events else pending
    event_seed = f"lifecycle_tail_recovered\0{source_hash}\0{len(ledger.valid_active_bytes)}".encode()
    draft = {
        "schemaVersion": 1,
        "protocolVersion": 2,
        "eventId": "ev_" + sha256(event_seed)[:32],
        # Поколение восстановления должно быть побайтно одинаковым при каждом повторе
        # до переключения. Ожидающее событие хоста уже содержит проверенный долговечный
        # образец часов.
        "at": pending["at"],
        "taskId": pending["taskId"],
        "attemptId": pending["attemptId"],
        "profile": base["profile"],
        "routeId": base["routeId"],
        "routeHash": base["routeHash"],
        "orchestratorSessionId": base["orchestratorSessionId"],
        "nodeVisitId": None,
        "nodeExecutionId": None,
        "nodeId": None,
        "runKey": None,
        "dispatchId": None,
        "runId": None,
        "epoch": None,
        "spanId": None,
        "kind": "lifecycle_tail_recovered",
        "writerVersion": "attempt-lifecycle-state/1",
        "clock": pending["clock"],
        "details": {
            "sourceSegmentSha256": source_hash,
            "validBytes": len(ledger.valid_active_bytes),
            "discardedBytes": len(ledger.torn_bytes),
            "lastValidEventHash": ledger.last_hash,
        },
    }
    # Черновиками восстановления владеет писатель, поэтому после добавления полей цепочки
    # проверяем их как закрытое событие, а не через защиту черновика вызывающего.
    if set(draft) != contract.draft_keys:
        io_fail("internal recovery envelope drift")
    return draft


def publish_quarantine(quarantine: str, source_hash: str, source: bytes) -> None:
    name = f"{source_hash}.ndjson"
    target = os.path.join(quarantine, name)
    if os.path.lexists(target):
        existing = secure_state_file(target, SEGMENT_LIMIT)
        if existing != source:
            fail("lifecycle-corruption", "content-addressed quarantine collision")
        descriptor = os.open(target, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        trace_step("recovery:quarantine_file_fsync")
    else:
        temp, descriptor = _temp_path(quarantine, "quarantine")
        try:
            _write_all(descriptor, source)
            os.fsync(descriptor)
            trace_step("recovery:quarantine_file_fsync")
        finally:
            os.close(descriptor)
        try:
            os.link(temp, target, follow_symlinks=False)
            os.unlink(temp)
        except FileExistsError:
            os.unlink(temp)
            existing = secure_state_file(target, SEGMENT_LIMIT)
            if existing != source:
                fail("lifecycle-corruption", "content-addressed quarantine collision")
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise
    _fsync_directory(quarantine)
    trace_step("recovery:quarantine_directory_fsync")


def recover_tail(
    lifecycle: str,
    ledger: Ledger,
    pending: dict[str, Any],
    contract: Contract,
) -> Ledger:
    if not ledger.torn_bytes:
        return ledger
    assert_active_unchanged(lifecycle, ledger)
    source_hash = sha256(ledger.active_bytes)
    publish_quarantine(os.path.join(lifecycle, "quarantine"), source_hash, ledger.active_bytes)
    draft = recovery_draft(ledger, pending, source_hash, contract)
    recovery, line = seal_event(draft, ledger.last_sequence + 1, ledger.last_hash, contract)
    generation = ledger.manifest["generation"] + 1
    if generation > SAFE_INTEGER:
        fail("lifecycle-corruption", "lifecycle generation overflow")
    active = f"active-{generation:016d}.ndjson"
    segments = os.path.join(lifecycle, "segments")
    publish_if_absent(
        segments,
        active,
        ledger.valid_active_bytes + line,
        mode=0o600,
        context="recovery",
        file_step="generation_file_fsync",
        directory_step="segments_directory_fsync",
    )
    assert_active_unchanged(lifecycle, ledger)
    publish_manifest_cas(
        lifecycle,
        make_manifest(generation, list(ledger.manifest["sealedSegments"]), active),
        ledger.manifest_snapshot,
        context="recovery",
    )
    selected = load_ledger(lifecycle, pending["taskId"], pending["attemptId"], contract)
    if selected.torn_bytes or selected.events[-1]["eventHash"] != recovery["eventHash"]:
        fail("lifecycle-corruption", "selected recovery generation does not match publication")
    write_tail(lifecycle, selected, context="recovery")
    return selected


def rotate_with_event(
    lifecycle: str,
    ledger: Ledger,
    event: dict[str, Any],
    line: bytes,
    task_id: str,
    attempt_id: str,
    contract: Contract,
) -> Ledger:
    assert_active_unchanged(lifecycle, ledger)
    descriptor = make_sealed_descriptor(ledger)
    generation = ledger.manifest["generation"] + 1
    if generation > SAFE_INTEGER:
        fail("lifecycle-corruption", "lifecycle generation overflow")
    active = f"active-{generation:016d}.ndjson"
    segments = os.path.join(lifecycle, "segments")
    publish_if_absent(
        segments,
        descriptor["name"],
        ledger.active_bytes,
        mode=0o400,
        context="rotation",
        file_step="sealed_file_fsync",
    )
    publish_if_absent(
        segments,
        active,
        line,
        mode=0o600,
        context="rotation",
        file_step="active_file_fsync",
    )
    _fsync_directory(segments)
    trace_step("rotation:segments_directory_fsync")
    assert_active_unchanged(lifecycle, ledger)
    sealed = list(ledger.manifest["sealedSegments"])
    sealed.append(descriptor)
    publish_manifest_cas(
        lifecycle,
        make_manifest(generation, sealed, active),
        ledger.manifest_snapshot,
        context="rotation",
    )
    selected = load_ledger(lifecycle, task_id, attempt_id, contract)
    if selected.torn_bytes or selected.events[-1]["eventHash"] != event["eventHash"]:
        fail("lifecycle-corruption", "selected rotation generation does not contain the pending event")
    write_tail(lifecycle, selected, context="rotation")
    return selected


def append_event(
    attempt_dir: str,
    task_id: str,
    attempt_id: str,
    draft_path: str,
    contract: Contract,
    segment_target: int,
) -> str:
    validate_path_identity(attempt_dir, task_id, attempt_id, contract)
    draft = validate_event(strict_json(read_input(draft_path, EVENT_LINE_LIMIT), "event draft"), contract, draft=True)
    if draft["taskId"] != task_id or draft["attemptId"] != attempt_id:
        fail("lifecycle-schema-invalid", "event draft identity does not match attempt path")
    lifecycle = os.path.join(attempt_dir, "lifecycle")
    if not os.path.isdir(lifecycle):
        fail("lifecycle-not-initialized", "lifecycle directory is missing", 3)
    lifecycle_fd = secure_directory(lifecycle)
    try:
        fcntl.flock(lifecycle_fd, fcntl.LOCK_EX)
        for child in ("segments", "quarantine", "usage"):
            child_fd = secure_directory(os.path.join(lifecycle, child))
            os.close(child_fd)
        ledger = load_ledger(lifecycle, task_id, attempt_id, contract)
        if ledger.torn_bytes:
            ledger = recover_tail(lifecycle, ledger, draft, contract)
        draft_bytes = canonical_bytes(draft, EVENT_LINE_LIMIT)
        for accepted in ledger.events:
            if accepted["eventId"] != draft["eventId"]:
                continue
            accepted_draft = {key: value for key, value in accepted.items() if key not in CHAIN_KEYS}
            if canonical_bytes(accepted_draft, EVENT_LINE_LIMIT) != draft_bytes:
                fail(
                    "lifecycle-event-id-conflict",
                    f"eventId {draft['eventId']} already has different canonical payload",
                    73,
                )
            write_tail(lifecycle, ledger, context="idempotent")
            return accepted["eventHash"]
        event, line = seal_event(draft, ledger.last_sequence + 1, ledger.last_hash, contract)
        validate_identity_sequence(ledger.events + [event], stored=False)
        if ledger.active_bytes and len(ledger.active_bytes) + len(line) > segment_target:
            rotate_with_event(
                lifecycle,
                ledger,
                event,
                line,
                task_id,
                attempt_id,
                contract,
            )
            return event["eventHash"]
        active_path = os.path.join(lifecycle, "segments", ledger.manifest["activeSegment"])
        assert_active_unchanged(lifecycle, ledger)
        # Повторно проверяем идентичность прямо перед открытием дескриптора для дописывания.
        before = os.lstat(active_path)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != 0o600
        ):
            fail("lifecycle-filesystem-invalid", "active segment is not one owned regular file")
        flags = os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(active_path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_uid != os.geteuid()
                or opened.st_nlink != 1
                or stat.S_IMODE(opened.st_mode) != 0o600
                or (
                    opened.st_dev,
                    opened.st_ino,
                    opened.st_size,
                    opened.st_mtime_ns,
                    opened.st_ctime_ns,
                )
                != (
                    before.st_dev,
                    before.st_ino,
                    before.st_size,
                    before.st_mtime_ns,
                    before.st_ctime_ns,
                )
            ):
                fail("lifecycle-filesystem-invalid", "active segment identity changed before append")
            if opened.st_size != len(ledger.active_bytes):
                fail("lifecycle-manifest-conflict", "active segment changed after validation")
            if opened.st_size + len(line) > SEGMENT_LIMIT:
                fail("lifecycle-corruption", "append would exceed the hard active segment limit")
            _write_all(descriptor, line)
            os.fsync(descriptor)
            trace_step("append:segment_fsync")
        finally:
            os.close(descriptor)
        accepted = load_ledger(lifecycle, task_id, attempt_id, contract)
        if accepted.torn_bytes or accepted.events[-1]["eventHash"] != event["eventHash"]:
            fail("lifecycle-corruption", "fsynced append did not become the selected chain tail")
        write_tail(lifecycle, accepted, context="append")
        return event["eventHash"]
    finally:
        try:
            fcntl.flock(lifecycle_fd, fcntl.LOCK_UN)
        finally:
            os.close(lifecycle_fd)


def read_or_validate(
    attempt_dir: str,
    task_id: str,
    attempt_id: str,
    contract: Contract,
    emit: bool,
) -> None:
    validate_path_identity(attempt_dir, task_id, attempt_id, contract)
    lifecycle = os.path.join(attempt_dir, "lifecycle")
    if not os.path.isdir(lifecycle):
        fail("lifecycle-not-initialized", "lifecycle directory is missing", 3)
    lifecycle_fd = secure_directory(lifecycle)
    try:
        fcntl.flock(lifecycle_fd, fcntl.LOCK_SH)
        ledger = load_ledger(lifecycle, task_id, attempt_id, contract)
        if ledger.torn_bytes:
            fail("lifecycle-incomplete", "active segment has a torn tail", 74)
        if emit:
            for line in ledger.lines:
                sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
    finally:
        try:
            fcntl.flock(lifecycle_fd, fcntl.LOCK_UN)
        finally:
            os.close(lifecycle_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--segment-bytes", default=str(DEFAULT_SEGMENT_TARGET))
    parser.add_argument("operation")
    parser.add_argument("arguments", nargs="*")
    return parser.parse_args()


def parse_segment_target(raw: str) -> int:
    if re.fullmatch(r"[1-9][0-9]*", raw) is None:
        fail("lifecycle-argument-invalid", "segment target must be a positive decimal integer", 2)
    target = int(raw)
    minimum = 1 if os.environ.get("FACTORY_TESTING") == "1" else EVENT_LINE_LIMIT
    if target < minimum or target > SEGMENT_LIMIT:
        fail(
            "lifecycle-argument-invalid",
            f"segment target must be within {minimum}..{SEGMENT_LIMIT} bytes",
            2,
        )
    return target


def require_arguments(args: argparse.Namespace, count: int) -> list[str]:
    if len(args.arguments) != count:
        fail("lifecycle-argument-invalid", f"{args.operation}: expected {count} arguments", 2)
    return args.arguments


def main() -> int:
    args = parse_args()
    contract = Contract(args.schema)
    segment_target = parse_segment_target(args.segment_bytes)
    if args.operation == "canonical":
        (path,) = require_arguments(args, 1)
        sys.stdout.buffer.write(canonical_bytes(strict_json(read_input(path), path)) + b"\n")
    elif args.operation == "event-hash":
        (path,) = require_arguments(args, 1)
        event = validate_event(strict_json(read_input(path, EVENT_LINE_LIMIT), path), contract, draft=False)
        print(event_hash(event))
    elif args.operation == "init":
        attempt_dir, task_id, attempt_id = require_arguments(args, 3)
        initialize(attempt_dir, task_id, attempt_id, contract)
    elif args.operation == "append":
        attempt_dir, task_id, attempt_id, draft = require_arguments(args, 4)
        print(append_event(attempt_dir, task_id, attempt_id, draft, contract, segment_target))
    elif args.operation == "read":
        attempt_dir, task_id, attempt_id = require_arguments(args, 3)
        read_or_validate(attempt_dir, task_id, attempt_id, contract, True)
    elif args.operation == "validate":
        attempt_dir, task_id, attempt_id = require_arguments(args, 3)
        read_or_validate(attempt_dir, task_id, attempt_id, contract, False)
    else:
        fail("lifecycle-argument-invalid", f"unknown operation {args.operation!r}", 2)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LifecycleFailure as error:
        print(f"{error.name}: {error.message}", file=sys.stderr)
        raise SystemExit(error.code)
