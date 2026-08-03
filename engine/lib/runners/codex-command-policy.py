#!/usr/bin/env python3
"""Fail-closed PreToolUse policy for the shared-stand Codex runner."""

from __future__ import annotations

import json
import re
import sys


COMMAND_TOKEN = r"(?:^|[\s;&|()])(?:command\s+|sudo\s+|env\s+)*(?:/[^\s;&|()]*/)?{}(?:\s|$)"


def deny(reason: str) -> None:
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


def main() -> int:
    if sys.argv[1:] != ["shared-stand"]:
        deny("Неизвестная policy Codex-runner; команда отклонена fail-closed.")
        return 0
    try:
        payload = json.load(sys.stdin)
    except (TypeError, ValueError):
        deny("PreToolUse получил повреждённый запрос; команда отклонена fail-closed.")
        return 0
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        deny("Shared-stand policy получила неподдерживаемый tool; вызов отклонён.")
        return 0
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not command or "\x00" in command:
        deny("Shared-stand policy не смогла разобрать команду; вызов отклонён.")
        return 0

    # Docker socket скрыт permission profile, поэтому эти проверки — понятная
    # диагностика и второй рубеж, включая абсолютный /usr/bin/docker и wrappers.
    if re.search(COMMAND_TOKEN.format("docker"), command, flags=re.IGNORECASE):
        deny("Прямой Docker запрещён; используй фиксированный stand-tool.sh.")
        return 0
    if "/var/run/docker.sock" in command or "/run/docker.sock" in command:
        deny("Прямой доступ к Docker socket запрещён.")
        return 0

    # :workspace делает .git read-only, а hook останавливает штатные и абсолютные
    # формы до появления даже пустого каталога назначения.
    git_segment = re.compile(
        r"(?:^|[\s;&|()])(?:command\s+|sudo\s+|env\s+)*(?:/[^\s;&|()]*/)?git\b"
        r"[^\n;&|]{0,768}\b(worktree|commit|push)\b",
        flags=re.IGNORECASE,
    )
    if git_segment.search(command):
        deny("git worktree/commit/push запрещены для no-ship shared-профиля.")
        return 0
    if re.search(COMMAND_TOKEN.format("gh"), command, flags=re.IGNORECASE) and re.search(
        r"\bpr\b", command, flags=re.IGNORECASE
    ):
        deny("Создание или изменение PR запрещено для no-ship shared-профиля.")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
