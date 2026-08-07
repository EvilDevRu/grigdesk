#!/usr/bin/env python3
"""Мост телеметрии Kimi: субагенты не видны в stream-json CLI.

Доказано на живом прогоне (t7783 BUILD, 2026-08-07): когда главный агент
делегирует работу инструментом `Agent`, CLI перестаёт писать в stdout вообще —
в `events.jsonl` не попадает ни сам вызов `Agent`, ни единого события субагентов.
Вся их работа уходит в `<KIMI_CODE_HOME>/sessions/<wd>/<session>/agents/<id>/wire.jsonl`.

Последствия без моста, оба наблюдались:
  * `events.jsonl` замирает на десятки минут при полностью здоровом ходе, а кокпит
    считает молчание по mtime этого файла — человека звали к работающему агенту;
  * `runner_kimi_fanout_count` не имел источника данных и возвращал ноль всегда.

Поэтому раннер пропускает поток CLI через этот мост. Мост — ЕДИНСТВЕННЫЙ писатель
журнала: строки CLI переливаются байт-в-байт, а события субагентов вливаются между
ними. Параллельная запись двумя процессами в один и тот же fd здесь не годится —
строки CLI доходят до 32 КБ (замер того же прогона), то есть многократно больше
PIPE_BUF, и атомарность append не гарантируется ни для одной из сторон.

Инвариант «в stdout только валидный NDJSON диалекта CLI» сохранён: мост добавляет
события той же формы (`role` = assistant/tool) и помечает их полями `agent`
и `bridge`, чтобы происхождение было различимо. Любой сбой обогащения гасится и
НЕ прерывает перелив: поток CLI важнее телеметрии.
"""

import glob
import json
import os
import sys
import threading

# Превью содержимого: журнал — телеметрия, а не хранилище выводов инструментов.
# Результат одного Read у субагента доходит до сотен килобайт, и тащить его целиком
# в events.jsonl незачем — важен факт и форма активности.
PREVIEW_LIMIT = 2000
SCAN_INTERVAL_S = 2.0

WRITE_LOCK = threading.Lock()


def _write_all(data):
    """Один write на строку под общим замком: мост — единственный писатель."""
    with WRITE_LOCK:
        offset = 0
        while offset < len(data):
            offset += os.write(1, data[offset:])


def _emit(payload):
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    _write_all(line.encode("utf-8", "replace"))


def _preview(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            value = str(value)
    if len(value) <= PREVIEW_LIMIT:
        return value
    return value[:PREVIEW_LIMIT] + f"… [обрезано, всего {len(value)} симв.]"


def _wire_files(home):
    pattern = os.path.join(home, "sessions", "*", "*", "agents", "*", "wire.jsonl")
    return sorted(glob.glob(pattern))


def _agent_id(path):
    return os.path.basename(os.path.dirname(path))


class WireTail:
    """Дочитывает wire-файлы с сохранением смещения и нормализует события.

    Из main мостится ТОЛЬКО делегирование (`Agent`): остальное главный агент и так
    пишет в stdout, дублировать его в журнале нельзя. Из agent-* мостится всё
    осмысленное — этих событий в журнале нет вовсе.
    """

    def __init__(self, home):
        self.home = home
        self.offsets = {}
        self.delegations = {}

    def scan(self):
        for path in _wire_files(self.home):
            try:
                self._drain(path)
            except OSError:
                # Файл мог исчезнуть вместе с per-run home; телеметрия не обязана
                # переживать это громко.
                continue

    def _drain(self, path):
        offset = self.offsets.get(path, 0)
        size = os.path.getsize(path)
        if size <= offset:
            # Файл усечён (пересоздан) — начинаем сначала, иначе смещение уедет
            # за конец и хвост больше никогда не прочитается.
            if size < offset:
                self.offsets[path] = 0
                offset = 0
            else:
                return
        agent = _agent_id(path)
        with open(path, "rb") as handle:
            handle.seek(offset)
            data = handle.read()
        # Неполный хвост не потребляем: строка дописывается прямо сейчас.
        cut = data.rfind(b"\n")
        if cut < 0:
            return
        self.offsets[path] = offset + cut + 1
        for raw in data[: cut + 1].splitlines():
            if not raw.strip():
                continue
            try:
                event = json.loads(raw.decode("utf-8", "replace"))
            except (TypeError, ValueError):
                continue
            for payload in self._normalize(agent, event):
                _emit(payload)

    def _normalize(self, agent, event):
        if not isinstance(event, dict):
            return []
        if event.get("type") != "context.append_loop_event":
            return []
        inner = event.get("event")
        if not isinstance(inner, dict):
            return []
        kind = inner.get("type")
        is_main = agent == "main"

        if kind == "tool.call":
            name = inner.get("name")
            call_id = inner.get("toolCallId")
            if is_main:
                if name != "Agent":
                    return []
                # Запоминаем, чтобы смостить и результат делегирования: у tool.result
                # имени инструмента нет, а без пары «вызов → итог» в журнале не видно,
                # чем закончился субагент.
                if call_id:
                    self.delegations[call_id] = True
            return [
                {
                    "role": "assistant",
                    "agent": agent,
                    "bridge": "kimi-wire",
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": call_id,
                            "function": {
                                "name": name,
                                "arguments": _preview(inner.get("args")),
                            },
                        }
                    ],
                }
            ]

        if kind == "tool.result":
            call_id = inner.get("toolCallId")
            if is_main and not self.delegations.get(call_id):
                return []
            result = inner.get("result")
            if isinstance(result, dict):
                content = result.get("output", result)
            else:
                content = result
            return [
                {
                    "role": "tool",
                    "agent": agent,
                    "bridge": "kimi-wire",
                    "tool_call_id": call_id,
                    "content": _preview(content),
                }
            ]

        if kind == "content.part" and not is_main:
            part = inner.get("part")
            if not isinstance(part, dict):
                return []
            part_kind = part.get("type")
            text = part.get(part_kind) if part_kind else None
            if not text:
                return []
            payload = {
                "role": "assistant",
                "agent": agent,
                "bridge": "kimi-wire",
            }
            if part_kind == "think":
                payload["thinking"] = _preview(text)
            else:
                payload["content"] = _preview(text)
            return [payload]

        return []


def _relay_stdin():
    """Перелив потока CLI. Обязан работать, даже если обогащение сломалось."""
    stream = sys.stdin.buffer
    while True:
        line = stream.readline()
        if not line:
            return
        _write_all(line)


def merge(home):
    tail = WireTail(home)
    stopped = threading.Event()
    # Сканер отдельным потоком: без него события субагентов ждали бы очередной
    # строки от CLI, а он молчит ровно всё время делегирования — то есть именно
    # тогда, когда телеметрия и нужна.
    def loop():
        while not stopped.wait(SCAN_INTERVAL_S):
            try:
                tail.scan()
            except Exception:
                return

    scanner = threading.Thread(target=loop, daemon=True)
    scanner.start()
    try:
        _relay_stdin()
    finally:
        stopped.set()
        scanner.join(timeout=5)
        try:
            tail.scan()
        except Exception:
            pass


def fanout(home):
    """Число делегирований за ход.

    Считается разбором JSON, а не грепом: `llm.tools_snapshot` содержит ОПИСАНИЕ
    инструмента Agent, поэтому `grep '"name": "Agent"'` дал бы ложный счёт на любом
    ходе, где делегирования не было вовсе.
    """
    total = 0
    for path in _wire_files(home):
        try:
            handle = open(path, "rb")
        except OSError:
            continue
        with handle:
            for raw in handle:
                if b'"Agent"' not in raw:
                    continue
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except (TypeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("type") != "context.append_loop_event":
                    continue
                inner = event.get("event")
                if not isinstance(inner, dict):
                    continue
                if inner.get("type") == "tool.call" and inner.get("name") == "Agent":
                    total += 1
    return total


def main(argv):
    if len(argv) != 3:
        print("usage: kimi-wire.py --merge|--fanout <kimi-home>", file=sys.stderr)
        return 2
    mode, home = argv[1], argv[2]
    if mode == "--merge":
        merge(home)
        return 0
    if mode == "--fanout":
        print(fanout(home))
        return 0
    print(f"kimi-wire: неизвестный режим {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except BrokenPipeError:
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
