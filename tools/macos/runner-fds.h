#ifndef GRIGDESK_RUNNER_FDS_H
#define GRIGDESK_RUNNER_FDS_H

#include <poll.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>

enum {
    RUN_DIR_FD = 3,
    RUN_GRANT_FD = 4,
    RUN_NONCE_LENGTH = 64,
    RUN_SOCKET_MS = 2000,
    RUN_GRANT_MS = 5000,
};

/*
 * Держатель знает закрытый набор операций над собственным run. Клиент каждой
 * операции получает фиксированный набор дескрипторов в фиксированном порядке.
 */
static size_t runner_fd_count(char operation)
{
    switch (operation) {
        case 'r': return 2;
        case 'p': return 3;
        case 'm':
        case 'f':
        case 'u': return 1;
        default: return 0;
    }
}

static int64_t runner_clock_ms(void)
{
    struct timespec now;

    return clock_gettime(CLOCK_MONOTONIC, &now) == 0
        ? (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000 : -1;
}

/*
 * Полный запрос и чтение nonce ограничены одним сроком, даже если отправитель
 * разбивает сообщение на байты или оставляет свой конец открытым.
 */
static bool runner_read_exact(int fd, unsigned char *bytes, size_t size)
{
    const int64_t start = runner_clock_ms();
    if (start < 0) {
        return false;
    }

    size_t offset = 0;
    while (offset < size) {
        const int64_t now = runner_clock_ms();
        if (now < start || now >= start + RUN_SOCKET_MS) {
            return false;
        }

        struct pollfd ready = { .fd = fd, .events = POLLIN };
        if (poll(&ready, 1, (int)(start + RUN_SOCKET_MS - now)) <= 0 || !(ready.revents & POLLIN)) {
            return false;
        }

        const ssize_t count = read(fd, bytes + offset, size - offset);
        if (count <= 0) {
            return false;
        }

        offset += (size_t)count;
    }

    return true;
}

/*
 * Socket лежит в удержанном 0700 каталоге. Относительное имя ограничивает
 * длину sockaddr_un независимо от пути папки данных.
 */
static struct sockaddr_un runner_socket_address(void)
{
    struct sockaddr_un address = { .sun_family = AF_UNIX, .sun_path = "fd" };
    address.sun_len = (unsigned char)sizeof(address);
    return address;
}

/*
 * Ограничение ввода-вывода относится к своему сокету. Отключение SIGPIPE на нём
 * сохраняет маску сигналов и поведение команды, которая получит дескрипторы.
 */
static bool runner_socket_peer(int fd)
{
    uid_t uid;
    gid_t gid;
    const int enabled = 1;
    const struct timeval timeout = { .tv_sec = RUN_SOCKET_MS / 1000 };

    return getpeereid(fd, &uid, &gid) == 0 && uid == geteuid()
        && setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) == 0
        && setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0
        && setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0;
}

/*
 * Получатель проверяет точный тип, длину и число FD. Вспомогательная память
 * выровнена под cmsghdr как на стороне отправления, так и при чтении.
 */
static bool runner_rights(int socket_fd, int *fds, size_t count, bool send)
{
    union {
        struct cmsghdr align;
        unsigned char bytes[CMSG_SPACE(3 * sizeof(int))];
    } control = { 0 };
    char tag = send ? 'F' : '\0';
    struct iovec data = { .iov_base = &tag, .iov_len = 1 };
    struct msghdr message = {
        .msg_iov = &data,
        .msg_iovlen = 1,
        .msg_control = control.bytes,
        .msg_controllen = send ? CMSG_SPACE(count * sizeof(int)) : sizeof(control.bytes),
    };

    if (send) {
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN(count * sizeof(int));
        memcpy(CMSG_DATA(header), fds, count * sizeof(int));

        return sendmsg(socket_fd, &message, 0) == 1;
    }

    if (recvmsg(socket_fd, &message, 0) != 1 || tag != 'F'
        || message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) {
        return false;
    }

    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (header == NULL || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS
        || header->cmsg_len != CMSG_LEN(count * sizeof(int)) || CMSG_NXTHDR(&message, header) != NULL) {
        return false;
    }

    memcpy(fds, CMSG_DATA(header), count * sizeof(int));
    return true;
}

/*
 * Каталог и имя сверяются перед READY. Путь используется только для lstat,
 * а новые файлы создаются и проверяются относительно удержанного dirfd.
 */
static bool retain_runner_files(char **args, int *files, struct stat *events)
{
    struct stat directory, named, writer, stderr_file;

    if (!private_run_directory(RUN_DIR_FD) || fstat(RUN_DIR_FD, &directory) != 0
        || args[3][0] != '/' || lstat(args[3], &named) != 0 || !same_fs_object(&directory, &named)) {
        return false;
    }

    char dev[32], ino[32];
    snprintf(dev, sizeof(dev), "%ju", (uintmax_t)directory.st_dev);
    snprintf(ino, sizeof(ino), "%ju", (uintmax_t)directory.st_ino);
    if (strcmp(dev, args[7]) != 0 || strcmp(ino, args[8]) != 0) {
        return false;
    }

    umask(077);
    const int flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC;
    files[1] = openat(RUN_DIR_FD, "events.jsonl", flags, 0600);
    files[0] = openat(RUN_DIR_FD, "events.jsonl", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    files[2] = openat(RUN_DIR_FD, "stderr.log", flags, 0600);

    return files[0] >= 0 && files[1] >= 0 && files[2] >= 0
        && fstat(files[0], events) == 0 && fstat(files[1], &writer) == 0
        && fstat(files[2], &stderr_file) == 0 && same_fs_object(events, &writer)
        && S_ISREG(events->st_mode) && (events->st_mode & 07777) == 0600
        && S_ISREG(stderr_file.st_mode) && (stderr_file.st_mode & 07777) == 0600
        && events->st_uid == geteuid() && stderr_file.st_uid == geteuid()
        && events->st_nlink == 1 && stderr_file.st_nlink == 1
        && lstat(args[3], &named) == 0 && same_fs_object(&directory, &named);
}

/*
 * Выдаёт разрешение из криптографического генератора только через control pipe.
 * Срок относится ко всей попытке, после первой подходящей пары операция закрыта.
 */
static bool runner_serve_grant(int listener, char operation, int *fds)
{
    unsigned char expected[1 + RUN_NONCE_LENGTH], random[RUN_NONCE_LENGTH / 2];
    static const char digits[] = "0123456789abcdef";
    expected[0] = (unsigned char)operation;
    arc4random_buf(random, sizeof(random));

    for (size_t index = 0; index < sizeof(random); index++) {
        expected[1 + index * 2] = digits[random[index] >> 4];
        expected[2 + index * 2] = digits[random[index] & 15];
    }

    if (printf("PERMIT %.*s\n", RUN_NONCE_LENGTH, (char *)expected + 1) < 0 || fflush(stdout) != 0) {
        return false;
    }

    const int64_t start = runner_clock_ms();
    for (int64_t now = start; now >= start && start >= 0 && now < start + RUN_GRANT_MS;
        now = runner_clock_ms()) {
        struct pollfd ready[] = {
            { .fd = STDIN_FILENO, .events = POLLIN },
            { .fd = listener, .events = POLLIN },
        };

        if (poll(ready, 2, (int)(start + RUN_GRANT_MS - now)) <= 0 || ready[0].revents != 0) {
            return true;
        }

        const int peer = accept(listener, NULL, NULL);
        if (peer < 0) {
            return false;
        }

        unsigned char request[sizeof(expected)];
        unsigned char difference = 0;
        const bool read = runner_socket_peer(peer) && runner_read_exact(peer, request, sizeof(request));

        if (read) {
            for (size_t index = 0; index < sizeof(request); index++) {
                difference |= request[index] ^ expected[index];
            }
        }

        const bool matched = read && difference == 0;
        if (matched) {
            runner_rights(peer, fds, runner_fd_count(operation), true);
        }

        close(peer);
        if (matched) {
            return true;
        }
    }

    return true;
}

/*
 * Пока Bash держит control pipe, broker удерживает read/write/stderr/dirfd.
 * EOF или закрывающая команда оставляют файлы прогона и убирают socket.
 */
static enum probe_status hold_runner_fds(char **args)
{
    if (!valid_task(args[4]) || (!valid_task(args[6]) && strcmp(args[6], "0") != 0)
        || strlen(args[5]) > 128 || args[5][0] == '\0'
        || strspn(args[5], "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
            != strlen(args[5])) {
        return PROBE_USAGE;
    }

    const int socket_dir = open(args[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (args[2][0] != '/' || socket_dir < 0 || !private_run_directory(socket_dir) || fchdir(socket_dir) != 0) {
        return PROBE_UNKNOWN;
    }

    struct stat events, socket_stat, socket_dir_stat, run_stat, named;
    int files[3];
    if (!retain_runner_files(args, files, &events) || fstat(RUN_DIR_FD, &run_stat) != 0
        || fstat(socket_dir, &socket_dir_stat) != 0
        || lstat(args[2], &named) != 0 || !same_fs_object(&socket_dir_stat, &named)) {
        return PROBE_UNKNOWN;
    }

    struct sockaddr_un address = runner_socket_address();
    const int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0
        || fstatat(socket_dir, "fd", &socket_stat, AT_SYMLINK_NOFOLLOW) != 0
        || !S_ISSOCK(socket_stat.st_mode) || socket_stat.st_uid != geteuid()) {
        return PROBE_UNKNOWN;
    }

    signal(SIGPIPE, SIG_IGN);
    enum probe_status result = PROBE_UNKNOWN;
    if (listen(listener, 4) == 0 && lstat(args[2], &named) == 0 && same_fs_object(&socket_dir_stat, &named)
        && lstat(args[3], &named) == 0 && same_fs_object(&run_stat, &named)
        && printf("READY %s %s %s %s %s %ju %ju\n",
            args[4], args[5], args[6], args[7], args[8],
            (uintmax_t)events.st_dev, (uintmax_t)events.st_ino) >= 0 && fflush(stdout) == 0) {
        char operation;

        for (;;) {
            const ssize_t length = read(STDIN_FILENO, &operation, 1);
            if (length == 0 || (length == 1 && operation == 'x')) {
                result = PROBE_OK;
                break;
            }
            if (length != 1 || runner_fd_count(operation) == 0) {
                break;
            }

            int exec_fds[] = { RUN_DIR_FD, -1, -1 };
            if (operation == 'r') {
                exec_fds[0] = files[1];
                exec_fds[1] = files[2];
            } else if (operation == 'p') {
                exec_fds[0] = files[0];
                exec_fds[1] = files[1];
                exec_fds[2] = RUN_DIR_FD;
            }

            if (!runner_serve_grant(listener, operation, exec_fds)) {
                break;
            }
        }
    }

    close(listener);
    if (fstatat(socket_dir, "fd", &named, AT_SYMLINK_NOFOLLOW) == 0 && same_fs_object(&socket_stat, &named)) {
        if (unlinkat(socket_dir, "fd", 0) != 0) {
            result = PROBE_UNKNOWN;
        }
    }

    return result;
}

/*
 * XNU SETEXEC заменяет этот же PID. CLOEXEC_DEFAULT закрывает все FD, кроме
 * явно перечисленных, в том числе nonce, сокет, остатки Bash и лишние копии.
 */
static enum probe_status runner_replace(char operation, int *fds, char **command)
{
    extern char **environ;
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_t actions;
    if (posix_spawnattr_init(&attributes) != 0 || posix_spawn_file_actions_init(&actions) != 0
        || posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT) != 0) {
        return PROBE_UNKNOWN;
    }

    const int out[] = { STDOUT_FILENO, STDERR_FILENO };
    const int prepare[] = { 7, 8, 9 };
    const int dir[] = { 9 };
    const int *destinations = operation == 'r' ? out : operation == 'p' ? prepare : dir;
    const int kept[] = { STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO };

    for (size_t index = 0; index < (operation == 'r' ? 2u : 3u); index++) {
        const int fd = operation == 'r' && index == 1 ? 7 : kept[index];

        if (posix_spawn_file_actions_addinherit_np(&actions, fd) != 0) {
            return PROBE_UNKNOWN;
        }
    }

    for (size_t index = 0; index < runner_fd_count(operation); index++) {
        const int isolated = fcntl(fds[index], F_DUPFD_CLOEXEC, 10);

        if (isolated < 0 || posix_spawn_file_actions_adddup2(&actions, isolated, destinations[index]) != 0) {
            return PROBE_UNKNOWN;
        }
    }

    posix_spawn(NULL, command[0], &actions, &attributes, command, environ);
    return PROBE_UNKNOWN;
}

/*
 * Клиент принимает nonce только в анонимном канале и соединяется с тем же UID.
 * При неправильной операции, ответе или дескрипторах команда не выполняется.
 */
static enum probe_status exec_runner_fds(char **args)
{
    const char operation = args[3][0];
    struct stat grant;
    if (strlen(args[3]) != 1 || runner_fd_count(operation) == 0 || args[2][0] != '/' || args[4][0] != '/'
        || fstat(RUN_GRANT_FD, &grant) != 0 || (!S_ISFIFO(grant.st_mode) && !S_ISSOCK(grant.st_mode))) {
        return PROBE_USAGE;
    }

    unsigned char request[1 + RUN_NONCE_LENGTH] = { (unsigned char)operation };
    if (!runner_read_exact(RUN_GRANT_FD, request + 1, RUN_NONCE_LENGTH)) {
        return PROBE_UNKNOWN;
    }

    const int work_dir = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    const int socket_dir = open(args[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int peer = socket(AF_UNIX, SOCK_STREAM, 0);
    if (work_dir < 0 || socket_dir < 0 || !private_run_directory(socket_dir) || peer < 0
        || fcntl(peer, F_SETFL, O_NONBLOCK) != 0 || fchdir(socket_dir) != 0) {
        return PROBE_UNKNOWN;
    }

    struct sockaddr_un address = runner_socket_address();
    if (connect(peer, (struct sockaddr *)&address, sizeof(address)) != 0) {
        struct pollfd ready = { .fd = peer, .events = POLLOUT };
        int error;
        socklen_t length = sizeof(error);

        if (errno != EINPROGRESS || poll(&ready, 1, RUN_SOCKET_MS) <= 0
            || getsockopt(peer, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error != 0) {
            return PROBE_UNKNOWN;
        }
    }

    int fds[3];
    if (fchdir(work_dir) != 0 || fcntl(peer, F_SETFL, 0) != 0 || !runner_socket_peer(peer)
        || send(peer, request, sizeof(request), 0) != (ssize_t)sizeof(request)
        || !runner_rights(peer, fds, runner_fd_count(operation), false)) {
        return PROBE_UNKNOWN;
    }

    return runner_replace(operation, fds, args + 4);
}

#endif
