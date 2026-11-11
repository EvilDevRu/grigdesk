"""Управляемый PTY авторизации: argv определяет только серверный адаптер."""

import errno
import os
import pty
import select
import signal
import sys
import time


def main():
    """Передаёт байты только одному серверному процессу login.

    После остановки завершает его группу, включая потомков интерактивного CLI.
    """
    if os.read(0, 1) != b'\0':
        return

    child, master = pty.fork()
    if child == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        while not stopping:
            ready, _, _ = select.select([master, 0], [], [], 0.1)
            for fd in ready:
                try:
                    data = os.read(fd, 16384)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not data:
                    return
                os.write(1 if fd == master else master, data)
    finally:
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            try:
                os.killpg(child, sig)
            except ProcessLookupError:
                pass
            time.sleep(0.05)
        os.close(master)
        try:
            os.waitpid(child, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    main()
