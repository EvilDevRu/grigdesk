"""PTY принадлежит одной фикстуре; команды и результаты идут отдельным JSON-каналом.
Снимок termios снимается до уборки, чтобы cleanup не скрывал дефект CLI.
"""
import base64
import errno
import fcntl
import json
import os
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time


def emit(value):
    """Передаёт запись без смешивания с байтами проверяемого терминала.
    Flush нужен для проверок вывода до завершения дочернего процесса.
    """
    print(json.dumps(value), flush=True)


def snapshot(fd):
    """Сериализует исходные настройки терминала вместе с управляющими символами.
    Сравнение до и после обнаруживает оставшийся raw mode и отключённое эхо.
    """
    values = termios.tcgetattr(fd)
    values[6] = [item if isinstance(item, int) else list(item) for item in values[6]]
    return values


def descendants(pid):
    """Собирает только потомков своего CLI, включая отдельные группы smoke-сторожа.
    Имена программ и порты для выбора процессов не используются.
    """
    result = []
    try:
        with open(f'/proc/{pid}/task/{pid}/children', encoding='ascii') as source:
            children = [int(item) for item in source.read().split()]
        for child in children:
            result.extend(descendants(child))
            result.append(child)
    except (FileNotFoundError, ProcessLookupError):
        pass
    return result


def main():
    """Запускает argv без shell с независимыми признаками TTY на stdin и stdout.
    После выхода оставляет slave открытым для достоверного снимка termios.
    """
    config = json.loads(sys.stdin.readline())
    master, slave = os.openpty()
    rows = config.get('rows', 24)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, config['columns'], 0, 0))
    before = snapshot(slave)

    def terminal_child():
        os.setsid()
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    child = subprocess.Popen(
        config['argv'], cwd=config['cwd'], env=config['env'],
        stdin=slave if config['inputTTY'] else subprocess.DEVNULL,
        stdout=slave if config['outputTTY'] else subprocess.PIPE,
        stderr=slave, preexec_fn=terminal_child,
    )
    emit({'pid': child.pid})
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ, 'control')
    selector.register(master, selectors.EVENT_READ, 'output')
    if child.stdout is not None:
        selector.register(child.stdout, selectors.EVENT_READ, 'output')
    pending = b''
    known = set()
    deadline = time.monotonic() + config.get('timeout', 18)
    exited_at = None
    try:
        while time.monotonic() < deadline:
            known.update(descendants(child.pid))
            if child.poll() is not None:
                exited_at = exited_at or time.monotonic()
                if time.monotonic() - exited_at > 0.1:
                    break
            for key, _ in selector.select(0.02):
                data = os.read(key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno(), 65536)
                if key.data == 'output':
                    if data:
                        emit({'output': base64.b64encode(data).decode('ascii')})
                    else:
                        selector.unregister(key.fileobj)
                    continue
                if not data:
                    raise RuntimeError('Канал управления закрыт')
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    command = json.loads(line)
                    if 'write' in command:
                        os.write(master, base64.b64decode(command['write']))
                    if 'resize' in command:
                        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                                    struct.pack('HHHH', rows, command['resize'], 0, 0))
                        os.kill(child.pid, signal.SIGWINCH)
                    if command.get('eof'):
                        # В raw mode Ctrl+D является клавишей, а не EOF.
                        # Канонический VEOF даёт настоящий конец stdin; CLI сам восстановит termios.
                        values = termios.tcgetattr(slave)
                        values[3] |= termios.ICANON
                        values[6][termios.VEOF] = b'\x04'
                        termios.tcsetattr(slave, termios.TCSANOW, values)
                        os.write(master, b'\x04')
                    if 'signal' in command and child.poll() is None:
                        os.kill(child.pid, getattr(signal, command['signal']))
                    if command.get('close'):
                        return
        code = child.poll()
        emit({'code': code if code is not None and code >= 0 else 128 - (code or -9),
              'before': before, 'after': snapshot(slave), 'timedOut': code is None})
        # Проверяющий должен увидеть дерево ДО уборки фикстурой.
        # Только явный close из t.after разрешает убивать оставшиеся процессы.
        while True:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            cleanup = False
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if json.loads(line).get('close'):
                    cleanup = True
            if cleanup:
                break
    finally:
        known.update(descendants(child.pid))
        for pid in [*known, child.pid]:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        selector.close()
        os.close(master)
        os.close(slave)


if __name__ == '__main__':
    main()
