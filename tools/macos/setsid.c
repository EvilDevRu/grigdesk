#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum {
    EXIT_CANNOT_EXEC = 126,
    EXIT_PERMIT_TIMEOUT = 124,
    PERMIT_TIMEOUT_MS = 10000,
};

/*
 * Разрешение приходит одним байтом по закрываемому унаследованному каналу.
 * Пока родитель записывает durable owner, дочерняя команда ещё не выполняется.
 */
static int await_permit(int fd)
{
    struct stat channel;

    if (fstat(fd, &channel) != 0 || (!S_ISFIFO(channel.st_mode) && !S_ISSOCK(channel.st_mode))) {
        return EXIT_CANNOT_EXEC;
    }

    struct pollfd input = { .fd = fd, .events = POLLIN };
    const int ready = poll(&input, 1, PERMIT_TIMEOUT_MS);

    if (ready == 0) {
        return EXIT_PERMIT_TIMEOUT;
    }

    unsigned char permit = 0;

    if (ready < 0 || (input.revents & POLLIN) == 0 || read(fd, &permit, 1) != 1 || permit != 1) {
        return EXIT_CANNOT_EXEC;
    }

    return 0;
}

/*
 * Новый процесс сохраняет PID и status FD через exec, но не открывает прав без permit.
 * Без permit wrapper запускает обычную команду сторожа в собственной сессии.
 */
int main(int argc, char **argv)
{
    int first = 1;
    int permit_fd = -1;

    if (argc >= 2 && strcmp(argv[1], "--permit-fd") == 0) {
        if (argc < 5 || strcmp(argv[3], "--") != 0 || argv[2][0] < '1' || argv[2][0] > '9') {
            return EXIT_CANNOT_EXEC;
        }

        char *end = NULL;
        errno = 0;
        const long fd = strtol(argv[2], &end, 10);

        if (errno != 0 || *end != '\0' || fd < 3 || fd == 7 || fd > INT_MAX) {
            return EXIT_CANNOT_EXEC;
        }

        permit_fd = (int)fd;
        first = 4;
    }

    if (argc <= first || setsid() < 0) {
        return EXIT_CANNOT_EXEC;
    }

    if (permit_fd >= 0) {
        const int result = await_permit(permit_fd);

        if (close(permit_fd) != 0 || result != 0) {
            return result != 0 ? result : EXIT_CANNOT_EXEC;
        }
    }

    execvp(argv[first], &argv[first]);
    perror("setsid exec");

    return EXIT_CANNOT_EXEC;
}
