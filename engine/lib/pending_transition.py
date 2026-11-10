"""Хранит проверенный host intent до подтверждения stage commit.
Сам модуль не продвигает маршрут и не доверяет состоянию, записанному агентом.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from bootstrap_state import read_json, trusted_directory

BIND = ('taskId', 'attemptId', 'profile', 'catalogHash', 'routeId', 'routeHash')


def fingerprint(path: Path) -> str:
    """Хеширует уже построенный снимок существующего workspace guard.
    Набор отслеживаемых и volatile файлов определяет прежний guard, не этот модуль.
    """
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            digest.update(block)
    return digest.hexdigest()


def directory(path: Path) -> None:
    """Проверяет host-owned путь и отсутствие symlink в родителях.
    Provider-writable STATE_DIR не используется для intent.
    """
    if path.parent.resolve() != path.parent:
        raise ValueError('родитель intent не канонический')
    trusted_directory(path.parent)
    if path.name != 'pending-transition.json':
        raise ValueError('неверное имя intent')


def load(path: Path) -> dict:
    """Читает неизменяемый receipt с закрытой схемой и буквальными argv.
    Отдельный shell/eval при replay не применяется.
    """
    directory(path)
    value, _ = read_json(path, immutable=True)
    if set(value) != {'schema', 'base', 'args', 'treeHash', 'origin'} or value['schema'] != 1:
        raise ValueError('неверная схема intent')
    args, base = value['args'], value['base']
    if (not isinstance(args, list) or len(args) != 11
            or any(not isinstance(v, str) or '\0' in v for v in args)
            or not isinstance(base, dict)
            or set(base) != {*BIND, 'eventSequence', 'headEventHash', 'currentNode'}
            or not re.fullmatch(r'[a-f0-9]{64}', value['treeHash'])):
        raise ValueError('неверные аргументы intent')
    if (not re.fullmatch(r'[1-9][0-9]{0,18}', args[0])
            or not re.fullmatch(r'a_[a-f0-9]{32}', args[1])
            or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,40}', args[2])
            or args[3] not in {'done', 'failed', 'skipped', 'exhausted'}
            or base['taskId'] != args[0] or base['attemptId'] != args[1]
            or base['currentNode'] != args[2]
            or type(base['eventSequence']) is not int or base['eventSequence'] < 0
            or not re.fullmatch(r'[a-f0-9]{64}', base['headEventHash'])
            or path.parent.name != args[1]
            or path.parent.parent.name != 'attempts'
            or path.parent.parent.parent.name != f't{args[0]}'):
        raise ValueError('identity intent расходится с каталогом')
    validate_origin(value['origin'], base, args)
    return value


def validate_origin(origin: dict | None, base: dict, args: list[str]) -> None:
    """Проверяет только host binding существующего визита, не принимая по нему исход.
    Полный lifecycle reader позже доказывает наличие ровно такого origin event.
    """
    if origin is None:
        return
    if (not isinstance(origin, dict)
            or set(origin) != {'nodeVisitId', 'orchestratorSessionId', 'node', 'runKey', 'cursorOrdinal'}
            or not isinstance(origin['nodeVisitId'], str)
            or not re.fullmatch(r'nv_[a-f0-9]{32}', origin['nodeVisitId'])
            or not isinstance(origin['orchestratorSessionId'], str)
            or not re.fullmatch(r'os_[a-f0-9]{32}', origin['orchestratorSessionId'])
            or origin['node'] != args[2] or not isinstance(origin['runKey'], str)
            or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', origin['runKey'])
            or origin['runKey'].lower() != args[2]
            or type(origin['cursorOrdinal']) is not int
            or origin['cursorOrdinal'] != base['eventSequence']):
        raise ValueError('origin visit не соответствует host intent')


def origin_from_context(state: dict, args: list[str]) -> dict | None:
    """Снимает identity с родительского host execution context при prepare.
    Child модели не может изменить это окружение родительского dispatcher.
    """
    env = os.environ
    keys = ('FACTORY_LIFECYCLE_TASK_ID', 'FACTORY_LIFECYCLE_ATTEMPT_ID',
            'FACTORY_LIFECYCLE_PROFILE', 'FACTORY_LIFECYCLE_SESSION_ID')
    if not any(env.get(key) for key in keys):
        return None
    expected = {
        'TASK_ID': 't' + args[0], 'ATTEMPT_ID': args[1], 'PROFILE': state['profile'],
        'ROUTE_ID': state['routeId'], 'ROUTE_HASH': state['routeHash'], 'NODE_ID': args[2],
    }
    for name, value in expected.items():
        if env.get('FACTORY_LIFECYCLE_' + name) != value:
            raise ValueError('host lifecycle scope расходится с intent')
    origin = {
        'nodeVisitId': env.get('FACTORY_LIFECYCLE_NODE_VISIT_ID'),
        'orchestratorSessionId': env.get('FACTORY_LIFECYCLE_SESSION_ID'),
        'node': args[2], 'runKey': env.get('FACTORY_LIFECYCLE_RUN_KEY'),
        'cursorOrdinal': state['eventSequence'],
    }
    validate_origin(origin, state, args)
    return origin


def select_origin(value: dict, rows: list[dict]) -> dict:
    """Выбирает единственный start exact visit из уже валидированного host ledger.
    Scope и ordinal проверяются до adopt; похожий последний done не используется.
    """
    origin, base = value['origin'], value['base']
    if origin is None:
        raise ValueError('у intent отсутствует lifecycle origin')
    matches = [row for row in rows if row.get('kind') == 'node_visit_started'
               and row.get('nodeVisitId') == origin['nodeVisitId']]
    if len(matches) != 1:
        raise ValueError('origin visit не найден однозначно')
    row = matches[0]
    expected = {
        'taskId': 't' + base['taskId'], 'attemptId': base['attemptId'], 'profile': base['profile'],
        'routeId': base['routeId'], 'routeHash': base['routeHash'],
        'orchestratorSessionId': origin['orchestratorSessionId'],
        'nodeId': origin['node'], 'runKey': origin['runKey'],
    }
    if (any(row.get(k) != v for k, v in expected.items())
            or row.get('details', {}).get('cursorOrdinal') != base['eventSequence']):
        raise ValueError('origin visit имеет чужой scope/ordinal')
    return row


def wait_stop(state: dict) -> bool:
    return state.get('state') == 'stopped' and state.get('stop') in {
        'human', 'failed', 'no-progress', 'rewind-limit', 'loop-ceiling',
    }


def sync_parent(path: Path) -> None:
    """Закрепляет rename/unlink на диске до возврата управления dispatcher.
    Ошибка синхронизации остаётся видимой как отказ записи.
    """
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prepare(path: Path, state: dict, sequence: int, tree: Path, args: list[str],
            origin: dict | None = None) -> None:
    """Публикует intent только для ещё текущего ready-узла после host postflight.
    Повтор не может переписать отличающийся сохранённый результат.
    """
    directory(path)
    if (state.get('state') != 'ready' or state.get('eventSequence') != sequence
            or state.get('currentNode') != args[2]):
        raise ValueError('cursor изменился после выполнения узла')
    value = {'schema': 1, 'args': args, 'treeHash': fingerprint(tree), 'origin': origin,
             'base': {k: state[k] for k in (*BIND, 'eventSequence', 'headEventHash', 'currentNode')}}
    validate_origin(origin, value['base'], args)
    if path.exists() or path.is_symlink():
        if load(path) != value:
            raise ValueError('другой pending intent уже существует')
        return
    fd, temporary_name = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(value, target, ensure_ascii=False, sort_keys=True)
            target.write('\n')
            target.flush()
            os.fchmod(target.fileno(), 0o400)
            os.fsync(target.fileno())
        os.replace(temporary, path)
        sync_parent(path)
        load(path)
    finally:
        temporary.unlink(missing_ok=True)


def classify(value: dict, state: dict, event: dict, event_raw: bytes, tree: Path | None) -> str:
    """Различает исходный CAS, уже записанный exact commit и новое посещение.
    Чужая identity является повреждением, а не причиной переисполнить старую работу.
    """
    base, args = value['base'], value['args']
    if any(state.get(k) != base[k] for k in BIND):
        raise ValueError('identity попытки изменилась')
    if (state['eventSequence'] == base['eventSequence']
            and state['headEventHash'] == base['headEventHash']):
        if state['state'] != 'ready' or state['currentNode'] != args[2]:
            raise ValueError('тот же CAS с другим cursor')
        if tree is None:
            return 'needs-tree'
        return 'ready' if fingerprint(tree) == value['treeHash'] else 'stale'
    if state['eventSequence'] < base['eventSequence']:
        raise ValueError('sequence уменьшилась')
    expected_verdict = json.loads(base64.b64decode(args[5], validate=True)) if args[5] else None
    if (state['eventSequence'] == base['eventSequence'] + 1
            and event.get('kind') in {'commit', 'no-progress', 'rewind-limit', 'loop-ceiling'}
            and event.get('node') == args[2]
            and event.get('outcome') == args[3]
            and event.get('previousEventHash') == base['headEventHash']
            and event.get('verdict') == expected_verdict
            and hashlib.sha256(event_raw).hexdigest() == state['headEventHash']):
        if event['kind'] == 'commit':
            if event.get('reason') != (args[9] or None):
                return 'stale'
        elif (state.get('state') != 'stopped' or state.get('stop') != event['kind']
              or not isinstance(event.get('action'), dict)
              or set(event['action']) != {'rewind', 'reset'}
              or not isinstance(event['action']['rewind'], str)
              or not isinstance(event['action']['reset'], list)
              or not isinstance(event.get('reason'), str) or not event['reason']):
            return 'stale'
        # Смысл safety-stop уже полностью проверен владельцем ledger. Его reason
        # создаёт writer, а не skipped feedback; повтор не переинтерпретирует его.
        return 'committed'
    return 'stale'


def main() -> None:
    """Получает файлы только от trusted shell wrapper, проверившего ledger.
    stdout содержит один статус или NUL-разделённый argv, никогда исполняемый shell.
    """
    op, path_raw, *args = sys.argv[1:]
    path = Path(path_raw)
    if op == 'prepare':
        state_name, sequence, tree_name, *commit_args = args
        state, _ = read_json(Path(state_name))
        prepare(path, state, int(sequence), Path(tree_name), commit_args,
                origin_from_context(state, commit_args))
        return
    value = load(path)
    if op == 'emit':
        values = [*value['args'], str(value['base']['eventSequence']), value['base']['headEventHash']]
        sys.stdout.buffer.write(('\0'.join(values) + '\0').encode())
    elif op == 'classify':
        state, _ = read_json(Path(args[0]))
        event, event_raw = read_json(Path(args[1]))
        tree = None if args[2] == '-' else Path(args[2])
        print(classify(value, state, event, event_raw, tree))
    elif op == 'probe-wait':
        state, _ = read_json(Path(args[0]))
        event, raw = read_json(Path(args[1]))
        if classify(value, state, event, raw, None) != 'committed' or not wait_stop(state):
            raise SystemExit(3)
    elif op == 'origin':
        rows = [json.loads(line) for line in Path(args[0]).read_text().splitlines() if line]
        print(json.dumps(select_origin(value, rows), ensure_ascii=False))
    elif op == 'has-origin':
        raise SystemExit(0 if value['origin'] is not None else 3)
    elif op == 'remove':
        path.unlink()
        sync_parent(path)
    elif op == 'archive':
        target = path.with_name(f'pending-transition.stale.{value["base"]["headEventHash"]}.json')
        os.replace(path, target)
        sync_parent(path)
    else:
        raise ValueError('неизвестная операция intent')


if __name__ == '__main__':
    try:
        main()
    except FileNotFoundError:
        raise SystemExit(3)
    except OSError as error:
        print(f'pending transition: ошибка I/O ({error.errno})', file=sys.stderr)
        raise SystemExit(74)
    except (ValueError, KeyError, TypeError) as error:
        print(f'pending transition: {error}', file=sys.stderr)
        raise SystemExit(78)
