#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

enum probe_status {
    PROBE_OK = 0,
    PROBE_DEAD = 3,
    PROBE_UNKNOWN = 74,
    PROBE_BUSY = 75,
    PROBE_USAGE = 78,
};

static bool same_start(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b)
{
    return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec
        && a->pbi_start_tvusec == b->pbi_start_tvusec;
}

/*
 * Отсутствие PID подтверждается ядром. Пустой либо короткий ответ libproc
 * и ошибка доступа остаются неизвестным состоянием.
 */
static enum probe_status read_process(pid_t pid, struct proc_bsdinfo *info)
{
    errno = 0;
    const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));

    if (size != (int)sizeof(*info)) {
        const int failure = errno;

        if (size <= 0 && (failure == ESRCH || failure == ENOENT)
            && kill(pid, 0) == -1 && errno == ESRCH) {
            return PROBE_DEAD;
        }

        return PROBE_UNKNOWN;
    }

    if (info->pbi_pid != (uint32_t)pid || info->pbi_uid != geteuid() || info->pbi_ruid != getuid()
        || info->pbi_start_tvsec == 0 || info->pbi_start_tvusec >= 1000000) {
        return PROBE_UNKNOWN;
    }

    return info->pbi_status == SZOMB ? PROBE_DEAD : PROBE_OK;
}

/*
 * Unix-путь может содержать пробелы, управляющие символы и кавычки.
 * Выход сохраняет эти байты в единственном JSON-значении.
 */
static void print_json_string(const char *value)
{
    putchar('"');

    for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
        if (*cursor == '\\' || *cursor == '"') {
            putchar('\\');
            putchar(*cursor);
        } else if (*cursor < 0x20) {
            printf("\\u%04x", (unsigned int)*cursor);
        } else {
            putchar(*cursor);
        }
    }

    putchar('"');
}

/*
 * Сопоставляет исполняемый файл и SID с той же инкарнацией PID.
 * Изменившийся либо неполный ответ не годится для остановки процесса.
 */
static enum probe_status print_identity(pid_t pid)
{
    struct proc_bsdinfo before;
    const enum probe_status initial = read_process(pid, &before);

    if (initial != PROBE_OK) {
        return initial;
    }

    const pid_t sid = getsid(pid);
    char executable[PROC_PIDPATHINFO_MAXSIZE];

    if (sid <= 0 || proc_pidpath(pid, executable, sizeof(executable)) <= 0 || executable[0] != '/') {
        return PROBE_UNKNOWN;
    }

    struct proc_bsdinfo after;
    const enum probe_status final = read_process(pid, &after);

    if (final != PROBE_OK) {
        return final;
    }

    char current[PROC_PIDPATHINFO_MAXSIZE];

    if (!same_start(&before, &after) || before.pbi_pgid != after.pbi_pgid
        || before.pbi_ppid != after.pbi_ppid || getsid(pid) != sid
        || proc_pidpath(pid, current, sizeof(current)) <= 0 || strcmp(current, executable) != 0
        || (before.pbi_status == SSTOP) != (after.pbi_status == SSTOP)) {
        return PROBE_UNKNOWN;
    }

    printf("{\"pid\":%d,\"uid\":%u,\"ppid\":%u,\"pgid\":%u,\"sid\":%d,",
        pid, after.pbi_uid, after.pbi_ppid, after.pbi_pgid, sid);
    printf("\"starttime\":\"%" PRIu64 "%06" PRIu64 "\",\"state\":\"%c\",\"executable\":",
        after.pbi_start_tvsec, after.pbi_start_tvusec, after.pbi_status == SSTOP ? 'T' : 'R');
    print_json_string(executable);
    puts("}");

    return ferror(stdout) ? PROBE_UNKNOWN : PROBE_OK;
}

/*
 * Отделяет null-terminated argv от служебного пути и окружения sysctl.
 * Только точные позиционные аргументы могут доказать владение задачей.
 */
static enum probe_status factory_argv(const char *buffer, size_t size, const char *task)
{
    int argc = 0;

    if (size <= sizeof(argc)) {
        return PROBE_UNKNOWN;
    }

    memcpy(&argc, buffer, sizeof(argc));

    if (argc <= 0 || (size_t)argc >= size - sizeof(argc)) {
        return PROBE_UNKNOWN;
    }

    const char *end = buffer + size;
    const char *cursor = memchr(buffer + sizeof(argc), '\0', size - sizeof(argc));

    if (cursor == NULL) {
        return PROBE_UNKNOWN;
    }

    while (cursor < end && *cursor == '\0') {
        cursor++;
    }

    int factory_index = -1;
    bool task_matches = false;

    for (int index = 0; index < argc; index++) {
        const char *next = memchr(cursor, '\0', (size_t)(end - cursor));

        if (next == NULL) {
            return PROBE_UNKNOWN;
        }

        const size_t length = (size_t)(next - cursor);
        const char *suffix = "/bin/factory";
        const size_t suffix_length = strlen(suffix);

        if (factory_index >= 0 && index == factory_index + 1) {
            task_matches = strcmp(cursor, task) == 0;
        }

        if (factory_index < 0 && index <= 1
            && (strcmp(cursor, "bin/factory") == 0
                || (length >= suffix_length && strcmp(next - suffix_length, suffix) == 0))) {
            factory_index = index;
        }

        cursor = next + 1;
    }

    return task_matches ? PROBE_OK : PROBE_DEAD;
}

/*
 * Читает только argv текущего поколения процесса в ограниченном буфере.
 * Сырой ответ может содержать секреты окружения и никогда не возвращается вызывающему.
 */
static enum probe_status inspect_factory(pid_t pid, const char *task)
{
    struct proc_bsdinfo before;
    const enum probe_status initial = read_process(pid, &before);

    if (initial != PROBE_OK) {
        return initial;
    }

    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t length = 1024 * 1024;
    char *buffer = malloc(length);

    if (buffer == NULL) {
        return PROBE_UNKNOWN;
    }

    enum probe_status args = PROBE_UNKNOWN;

    if (sysctl(mib, 3, buffer, &length, NULL, 0) == 0) {
        args = factory_argv(buffer, length, task);
    }

    free(buffer);

    struct proc_bsdinfo after;
    const enum probe_status final = read_process(pid, &after);

    if (final != PROBE_OK) {
        return final;
    }

    return same_start(&before, &after) ? args : PROBE_UNKNOWN;
}

struct census_row {
    struct proc_bsdinfo info;
    pid_t sid;
};

/*
 * Снимает полный буфер KERN_PROC_UID. При росте списка ядро отдаёт ENOMEM,
 * после чего берём новый размер и пробуем заново с ограничением.
 */
static struct kinfo_proc *read_census(size_t *count)
{
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)geteuid() };

    for (int attempt = 0; attempt < 4; attempt++) {
        size_t size = 0;

        if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0 || size == 0 || size > 8 * 1024 * 1024) {
            return NULL;
        }

        struct kinfo_proc *rows = malloc(size);

        if (rows == NULL) {
            return NULL;
        }

        if (sysctl(mib, 4, rows, &size, NULL, 0) == 0) {
            if (size > 0 && size % sizeof(*rows) == 0) {
                *count = size / sizeof(*rows);

                return rows;
            }

            free(rows);

            return NULL;
        }

        const int failure = errno;
        free(rows);

        if (failure != ENOMEM) {
            return NULL;
        }
    }

    return NULL;
}

/*
 * Дополняет запись SID и полным временем старта. При изменении поколения,
 * ancestry или сбое чтения весь census остаётся неполным.
 */
static enum probe_status census_identity(const struct kinfo_proc *row, struct census_row *result)
{
    const pid_t pid = row->kp_proc.p_pid;

    if (row->kp_proc.p_stat == SZOMB) {
        return PROBE_DEAD;
    }

    struct proc_bsdinfo before;
    const enum probe_status first = read_process(pid, &before);

    if (first != PROBE_OK) {
        return first;
    }

    const pid_t sid = getsid(pid);
    struct proc_bsdinfo after;
    const enum probe_status second = read_process(pid, &after);

    if (second != PROBE_OK) {
        return second;
    }

    if (sid <= 0 || getsid(pid) != sid || !same_start(&before, &after)
        || after.pbi_start_tvsec != (uint64_t)row->kp_proc.p_starttime.tv_sec
        || after.pbi_start_tvusec != (uint64_t)row->kp_proc.p_starttime.tv_usec
        || before.pbi_pgid != after.pbi_pgid || before.pbi_ppid != after.pbi_ppid
        || after.pbi_pgid != (uint32_t)row->kp_eproc.e_pgid
        || after.pbi_ppid != (uint32_t)row->kp_eproc.e_ppid) {
        return PROBE_UNKNOWN;
    }

    result->info = after;
    result->sid = sid;

    return PROBE_OK;
}

/*
 * Любая неполная запись отменяет весь census. Себя сверяем с буфером ядра,
 * но исключаем из результата, потому что следующий helper получит свой PID.
 */
static struct census_row *collect_census(size_t *result_count)
{
    size_t count = 0;
    struct kinfo_proc *rows = read_census(&count);

    if (rows == NULL) {
        return NULL;
    }

    struct census_row *live = calloc(count, sizeof(*live));
    size_t length = 0;
    bool self_seen = false;

    if (live == NULL) {
        free(rows);

        return NULL;
    }

    for (size_t index = 0; index < count; index++) {
        const enum probe_status state = census_identity(&rows[index], &live[length]);

        if (state == PROBE_UNKNOWN) {
            free(rows);
            free(live);

            return NULL;
        }

        if (state == PROBE_OK) {
            if (live[length].info.pbi_pid == (uint32_t)getpid()) {
                self_seen = true;
            } else {
                length++;
            }
        }
    }

    free(rows);

    if (!self_seen) {
        free(live);

        return NULL;
    }

    *result_count = length;
    return live;
}

/*
 * Отдаёт только полный census. Ни argv, ни пути процессов в JSON не попадают.
 */
static enum probe_status print_census(void)
{
    size_t length = 0;
    struct census_row *live = collect_census(&length);
    if (live == NULL) {
        return PROBE_UNKNOWN;
    }

    putchar('[');

    for (size_t index = 0; index < length; index++) {
        const struct proc_bsdinfo *info = &live[index].info;

        printf("%s{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"sid\":%d,\"starttime\":\"%" PRIu64 "%06" PRIu64 "\"}",
            index == 0 ? "" : ",", info->pbi_pid, info->pbi_ppid, info->pbi_pgid, live[index].sid,
            info->pbi_start_tvsec, info->pbi_start_tvusec);
    }

    free(live);

    return puts("]") < 0 ? PROBE_UNKNOWN : PROBE_OK;
}

/*
 * Сигнал адресуется одному участнику стадии. UID, поколение PID и принадлежность
 * сессии и группе проверяются в том же вызове непосредственно перед сигналом.
 */
static enum probe_status signal_stage_member(pid_t pid, const char *token, const char *session,
    const char *group, const char *name)
{
    int signal_number = 0;
    if (strcmp(name, "TERM") == 0) {
        signal_number = SIGTERM;
    } else if (strcmp(name, "INT") == 0) {
        signal_number = SIGINT;
    } else if (strcmp(name, "KILL") == 0) {
        signal_number = SIGKILL;
    } else if (strcmp(name, "CONT") == 0) {
        signal_number = SIGCONT;
    }
    if (pid <= 1 || signal_number == 0) {
        return PROBE_USAGE;
    }

    struct proc_bsdinfo before;
    const enum probe_status initial = read_process(pid, &before);
    if (initial != PROBE_OK) {
        return initial;
    }

    const pid_t sid = getsid(pid);
    struct proc_bsdinfo after;
    const enum probe_status final = read_process(pid, &after);
    if (final != PROBE_OK) {
        return final;
    }

    char start[40];
    char sid_text[16];
    char pgid_text[16];
    snprintf(start, sizeof(start), "%" PRIu64 "%06" PRIu64, after.pbi_start_tvsec, after.pbi_start_tvusec);
    snprintf(sid_text, sizeof(sid_text), "%d", sid);
    snprintf(pgid_text, sizeof(pgid_text), "%u", after.pbi_pgid);

    if (strcmp(start, token) != 0) {
        return PROBE_DEAD;
    }
    if (sid <= 0 || !same_start(&before, &after) || before.pbi_pgid != after.pbi_pgid
        || getsid(pid) != sid || strcmp(sid_text, session) != 0 || strcmp(pgid_text, group) != 0) {
        return PROBE_UNKNOWN;
    }

    if (kill(pid, signal_number) == 0) {
        return PROBE_OK;
    }

    return errno == ESRCH ? PROBE_DEAD : PROBE_UNKNOWN;
}

/*
 * Операции телеметрии работают только в уже открытом приватном каталоге раннера.
 * Номер FD приходит из launcher, а имя ресурса фиксировано в helper.
 */
static bool private_run_directory(int fd)
{
    struct stat directory;

    return fstat(fd, &directory) == 0 && S_ISDIR(directory.st_mode)
        && directory.st_uid == geteuid() && (directory.st_mode & 07777) == 0700;
}

/*
 * Печатает UID, mode и nlink того же файла, который Bash будет читать через FD.
 * Отдельное открытие pathname или переход через /dev/fd не требуется.
 */
static enum probe_status runner_fd_stat(int fd)
{
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid()) {
        return PROBE_UNKNOWN;
    }

    printf("%ju:%o:%ju\n", (uintmax_t)info.st_uid, (unsigned int)(info.st_mode & 07777),
        (uintmax_t)info.st_nlink);
    return ferror(stdout) ? PROBE_UNKNOWN : PROBE_OK;
}

/*
 * Публикация trusted identity синхронизирует именно собственный файл или
 * приватный parent. Ссылки и чужие объекты не проходят по этому FD.
 */
static enum probe_status sync_runner_fd(int fd)
{
    struct stat info;
    if (fstat(fd, &info) != 0 || info.st_uid != geteuid()) {
        return PROBE_UNKNOWN;
    }

    const bool directory = S_ISDIR(info.st_mode) && (info.st_mode & 07777) == 0700;
    const bool file = S_ISREG(info.st_mode) && (info.st_mode & 07777) == 0600 && info.st_nlink == 1;

    return (directory || file) && fsync(fd) == 0 ? PROBE_OK : PROBE_UNKNOWN;
}

static bool same_fs_object(const struct stat *before, const struct stat *after)
{
    return before->st_dev == after->st_dev && before->st_ino == after->st_ino;
}

static bool valid_task(const char *task);

/* Открываемая для чтения блокировка обязана оставаться тем же именованным inode. */
static enum probe_status verify_task_lock(int fd, int directory, const char *task)
{
    char name[48];
    struct stat parent;
    struct stat source;
    struct stat named;

    if (!valid_task(task) || snprintf(name, sizeof(name), "t%s.lock", task) < 0
        || fstat(directory, &parent) != 0 || !S_ISDIR(parent.st_mode)
        || parent.st_uid != geteuid() || (parent.st_mode & 0022) != 0
        || fstat(fd, &source) != 0 || !S_ISREG(source.st_mode) || source.st_uid != geteuid()
        || source.st_nlink != 1 || (source.st_mode & 0022) != 0
        || fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_fs_object(&source, &named)) {
        return PROBE_UNKNOWN;
    }

    return PROBE_OK;
}

struct bound_runner {
    pid_t leader;
    char name[32];
    char start[40];
    struct stat source;
    char content[2048];
    size_t length;
};


/*
 * Удержанная запись и имя каталога сверяются непосредственно перед сигналом.
 * Открытый FD переживает rename, поэтому одного чтения FD было бы недостаточно.
 */
static bool runner_binding_current(int file, int directory, const struct bound_runner *binding)
{
    struct stat stat;
    char content[sizeof(binding->content)];
    return fstatat(directory, binding->name, &stat, AT_SYMLINK_NOFOLLOW) == 0
        && same_fs_object(&binding->source, &stat) && stat.st_nlink == 1 && stat.st_uid == geteuid()
        && (stat.st_mode & 07777) == 0600 && stat.st_size == (off_t)binding->length
        && pread(file, content, sizeof(content), 0) == (ssize_t)binding->length
        && memcmp(binding->content, content, binding->length) == 0;
}

static bool decimal(const char *text, size_t min, size_t max)
{
    const size_t len = strlen(text);
    return len >= min && len <= max && strspn(text, "0123456789") == len;
}

/*
 * Следует закрытому существующему SCHEMA=1. Строки принятого поколения
 * сохраняются без изменений для последующей сверки.
 */
static bool read_runner_binding(int file, int directory, struct bound_runner *binding)
{
    if (!private_run_directory(directory) || fstat(file, &binding->source) != 0
        || !S_ISREG(binding->source.st_mode) || binding->source.st_uid != geteuid()
        || (binding->source.st_mode & 07777) != 0600 || binding->source.st_nlink != 1
        || binding->source.st_size <= 0 || (size_t)binding->source.st_size >= sizeof(binding->content)) {
        return false;
    }

    const ssize_t length = pread(file, binding->content, sizeof(binding->content), 0);
    if (length != binding->source.st_size || memchr(binding->content, '\0', (size_t)length) != NULL) {
        return false;
    }

    char copy[sizeof(binding->content)];
    memcpy(copy, binding->content, (size_t)length);
    copy[length] = '\0';
    char *position = copy;
    const char *fields[] = { "SCHEMA=", "TASK=", "STAGE=", "RUN_ID=", "EPOCH=", "RUNNER=",
        "PID=", "PGID=", "SESSION=", "STARTTIME=", "STATE=" };
    char *values[sizeof(fields) / sizeof(*fields)];
    for (size_t index = 0; index < sizeof(fields) / sizeof(*fields); index++) {
        char *line = strsep(&position, "\n");
        const size_t prefix = strlen(fields[index]);
        if (line == NULL || strncmp(line, fields[index], prefix) != 0 || line[prefix] == '\0') {
            return false;
        }
        values[index] = line + prefix;
    }

    if (position == NULL || *position != '\0' || strcmp(values[0], "1") != 0 || !valid_task(values[1])
        || values[2][0] < 'A' || values[2][0] > 'Z' || strlen(values[2]) > 64
        || strspn(values[2], "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") != strlen(values[2])
        || strlen(values[3]) > 160
        || strspn(values[3], "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-") != strlen(values[3])
        || !decimal(values[4], 1, 20)
        || values[5][0] < 'a' || values[5][0] > 'z'
        || strspn(values[5], "abcdefghijklmnopqrstuvwxyz0123456789_-") != strlen(values[5])
        || strcmp(values[10], "active") != 0 || !decimal(values[6], 1, 10)
        || strcmp(values[6], values[7]) != 0 || strcmp(values[6], values[8]) != 0
        || !decimal(values[9], 7, 26)) {
        return false;
    }

    const long leader = strtol(values[6], NULL, 10);
    if (leader <= 1 || leader > INT_MAX || getsid(0) == (pid_t)leader) {
        return false;
    }

    binding->leader = (pid_t)leader;
    binding->length = (size_t)length;
    snprintf(binding->name, sizeof(binding->name), "t%s.active", values[1]);
    snprintf(binding->start, sizeof(binding->start), "%s", values[9]);
    return runner_binding_current(file, directory, binding);
}

static void format_census_start(const struct proc_bsdinfo *process, char *token, size_t size)
{
    snprintf(token, size, "%" PRIu64 "%06" PRIu64, process->pbi_start_tvsec, process->pbi_start_tvusec);
}

/*
 * Kernel SID остаётся у членов после ухода лидера. Переиспользованный PID
 * лидера или участник, рождённый до этой сессии, отменяет весь снимок.
 */
static bool runner_member_valid(const struct bound_runner *binding, const struct census_row *row)
{
    char token[40];
    format_census_start(&row->info, token, sizeof(token));
    if (row->info.pbi_pid == (uint32_t)binding->leader) {
        return strcmp(token, binding->start) == 0 && row->sid == binding->leader
            && row->info.pbi_pgid == (uint32_t)binding->leader;
    }
    if (row->sid != binding->leader) {
        return true;
    }
    const size_t a = strlen(token), b = strlen(binding->start);
    return a > b || (a == b && strcmp(token, binding->start) >= 0);
}

/*
 * Тот же существующий engine lock удерживается по общему открытому descriptor.
 * Закрытие дочерней копии не отпускает захват, пока хост держит свою.
 */
static enum probe_status lock_bound_runner(int fd, int directory, const struct bound_runner *binding)
{
    struct stat directory_info, held, named;
    char lock_name[32];
    const size_t prefix = strlen(binding->name) - strlen(".active");
    snprintf(lock_name, sizeof(lock_name), "%.*s.lock", (int)prefix, binding->name);
    if (fstat(directory, &directory_info) != 0 || !S_ISDIR(directory_info.st_mode)
        || directory_info.st_uid != geteuid() || (directory_info.st_mode & 0022) != 0
        || fstat(fd, &held) != 0 || !S_ISREG(held.st_mode) || held.st_nlink != 1
        || held.st_uid != geteuid() || (held.st_mode & 0022) != 0
        || fstatat(directory, lock_name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_fs_object(&held, &named)) {
        return PROBE_UNKNOWN;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        return errno == EWOULDBLOCK ? PROBE_BUSY : PROBE_UNKNOWN;
    }
    return fstatat(directory, lock_name, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_fs_object(&held, &named)
        ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * Host FD передаёт exact protected runner. Полный census предшествует любым
 * сигналам. Участники повторно сверяются с тем же поколением и тем же FD.
 */
static enum probe_status quiesce_bound_runner(int file, int directory, int lock, int lock_directory)
{
    struct bound_runner binding;
    if (!read_runner_binding(file, directory, &binding)) {
        return PROBE_UNKNOWN;
    }
    const enum probe_status admitted = lock_bound_runner(lock, lock_directory, &binding);
    if (admitted != PROBE_OK) {
        return admitted;
    }

    int empty = 0;
    bool soft_sent = false;
    struct timespec began;
    if (clock_gettime(CLOCK_MONOTONIC, &began) != 0) {
        return PROBE_UNKNOWN;
    }
    for (;;) {
        struct timespec now;
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec - began.tv_sec >= 10
            || !runner_binding_current(file, directory, &binding)) {
            return PROBE_UNKNOWN;
        }
        size_t count = 0;
        struct census_row *rows = collect_census(&count);
        if (rows == NULL) {
            return PROBE_UNKNOWN;
        }
        size_t members = 0;
        bool exact = true;
        for (size_t i = 0; i < count; i++) {
            exact = exact && runner_member_valid(&binding, &rows[i]);
            members += (rows[i].sid == binding.leader);
        }
        if (exact && members == 0) {
            empty++;
        } else {
            empty = 0;
        }
        char sid[16];
        snprintf(sid, sizeof(sid), "%d", binding.leader);
        const bool hard = now.tv_sec - began.tv_sec >= 4;
        for (size_t i = 0; exact && (!soft_sent || hard) && i < count; i++) {
            const struct census_row *row = &rows[i];
            if (row->sid != binding.leader) {
                continue;
            }
            char token[40], group[16];
            format_census_start(&row->info, token, sizeof(token));
            snprintf(group, sizeof(group), "%u", row->info.pbi_pgid);
            enum probe_status delivered = PROBE_UNKNOWN;
            if (runner_binding_current(file, directory, &binding)) {
                delivered = signal_stage_member((pid_t)row->info.pbi_pid, token, sid, group, hard ? "KILL" : "TERM");
            }
            exact = delivered == PROBE_OK || delivered == PROBE_DEAD;
            if (exact && !hard && row->info.pbi_status == SSTOP) {
                delivered = runner_binding_current(file, directory, &binding)
                    ? signal_stage_member((pid_t)row->info.pbi_pid, token, sid, group, "CONT") : PROBE_UNKNOWN;
                exact = delivered == PROBE_OK || delivered == PROBE_DEAD;
            }
        }
        soft_sent = soft_sent || members > 0;
        free(rows);
        if (!exact || empty >= 2) {
            return exact && runner_binding_current(file, directory, &binding) ? PROBE_OK : PROBE_UNKNOWN;
        }
        const struct timespec wait = { .tv_nsec = 50000000 };
        nanosleep(&wait, NULL);
    }
}

/*
 * fsync выполняется над открытым объектом, а затем над удержанным родителем.
 * Оба сравнения имени отделяют ошибку синхронизации от посторонней замены.
 */
static enum probe_status sync_restored_object(int directory, const char *kind, const char *name)
{
    struct stat parent, before, after;
    if (strchr(name, '/') != NULL || name[0] == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0
        || fstat(directory, &parent) != 0 || !S_ISDIR(parent.st_mode) || parent.st_uid != geteuid()) {
        return PROBE_UNKNOWN;
    }

    const int present = fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW);
    if (strcmp(kind, "missing") == 0) {
        return present == -1 && errno == ENOENT && fsync(directory) == 0
            && fstatat(directory, name, &after, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT
            ? PROBE_OK : PROBE_UNKNOWN;
    }

    if (present != 0 || before.st_uid != geteuid()) {
        return PROBE_UNKNOWN;
    }

    if (strcmp(kind, "symlink") == 0) {
        return S_ISLNK(before.st_mode) && fsync(directory) == 0
            && fstatat(directory, name, &after, AT_SYMLINK_NOFOLLOW) == 0 && same_fs_object(&before, &after)
            ? PROBE_OK : PROBE_UNKNOWN;
    }

    const bool subdirectory = strcmp(kind, "directory") == 0 && S_ISDIR(before.st_mode);
    const bool regular = strcmp(kind, "file") == 0 && S_ISREG(before.st_mode) && before.st_nlink == 1;
    if (!subdirectory && !regular) {
        return PROBE_UNKNOWN;
    }

    const int flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (subdirectory ? O_DIRECTORY : 0);
    const int fd = openat(directory, name, flags);
    if (fd < 0) {
        return PROBE_UNKNOWN;
    }

    const bool success = fstat(fd, &after) == 0 && same_fs_object(&before, &after)
        && fsync(fd) == 0 && fsync(directory) == 0
        && fstatat(directory, name, &after, AT_SYMLINK_NOFOLLOW) == 0 && same_fs_object(&before, &after);
    return close(fd) == 0 && success ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * Вызывается с TX lock. Указатель читается с того же FD, чей inode сверяется;
 * при уже снятом указателе повтор всё равно подтверждает sync родителя.
 */
static enum probe_status clear_tx_pointer(int directory, const char *transaction)
{
    struct stat parent, before, named;
    if (transaction[0] == '\0' || strlen(transaction) > 81
        || strspn(transaction, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
            != strlen(transaction)
        || fstat(directory, &parent) != 0 || !S_ISDIR(parent.st_mode)
        || parent.st_uid != geteuid() || (parent.st_mode & 0022) != 0) {
        return PROBE_USAGE;
    }

    const char *pointer = "active.env";
    const int fd = openat(directory, pointer, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        return errno == ENOENT && fsync(directory) == 0 ? PROBE_OK : PROBE_UNKNOWN;
    }

    char expected[128], actual[129];
    const int length = snprintf(expected, sizeof(expected), "SCHEMA=1\nTRANSACTION_ID=%s\n", transaction);
    const bool matched = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == geteuid()
        && (before.st_mode & 07777) == 0600 && before.st_nlink == 1 && before.st_size == length
        && pread(fd, actual, sizeof(actual), 0) == length && memcmp(actual, expected, (size_t)length) == 0
        && fstatat(directory, pointer, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_fs_object(&before, &named);
    if (close(fd) != 0 || !matched) {
        return PROBE_UNKNOWN;
    }

    return unlinkat(directory, pointer, 0) == 0 && fsync(directory) == 0 ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * Снимает отпечаток имени относительно удержанного каталога без открытия файла.
 * ENOENT отличается от подмены, доступа и прочих ошибок чтения.
 */
static enum probe_status run_events_stat(int fd)
{
    if (!private_run_directory(fd)) {
        return PROBE_UNKNOWN;
    }

    struct stat info;
    if (fstatat(fd, "events.jsonl", &info, AT_SYMLINK_NOFOLLOW) != 0) {
        return errno == ENOENT ? PROBE_DEAD : PROBE_UNKNOWN;
    }
    if (!S_ISREG(info.st_mode) || info.st_uid != geteuid() || info.st_size < 0
        || info.st_mtimespec.tv_sec < 0 || info.st_mtimespec.tv_nsec < 0) {
        return PROBE_UNKNOWN;
    }

    printf("{\"dev\":\"%ju\",\"ino\":\"%ju\",\"size\":\"%ju\",\"mtimeNs\":\"%ju%09ld\","
        "\"mode\":%u,\"nlink\":\"%ju\",\"regular\":true,\"directory\":false}\n",
        (uintmax_t)info.st_dev, (uintmax_t)info.st_ino, (uintmax_t)info.st_size,
        (uintmax_t)info.st_mtimespec.tv_sec, info.st_mtimespec.tv_nsec,
        (unsigned int)(info.st_mode & 07777), (uintmax_t)info.st_nlink);

    return ferror(stdout) ? PROBE_UNKNOWN : PROBE_OK;
}

/*
 * Записывает ограниченное зеркало через уникальный временный inode в dirfd.
 * renameat заменяет запись meta.env целиком, в том числе висячую ссылку.
 */
static enum probe_status write_run_meta(int fd)
{
    enum { META_BYTES = 64 * 1024 };
    unsigned char bytes[META_BYTES + 1];
    size_t length = 0;

    if (!private_run_directory(fd)) {
        return PROBE_UNKNOWN;
    }

    while (length < sizeof(bytes)) {
        const ssize_t got = read(STDIN_FILENO, bytes + length, sizeof(bytes) - length);

        if (got < 0) {
            return PROBE_UNKNOWN;
        }
        if (got == 0) {
            break;
        }
        length += (size_t)got;
    }
    if (length == 0 || length > META_BYTES) {
        return PROBE_USAGE;
    }

    uint64_t nonce;
    arc4random_buf(&nonce, sizeof(nonce));
    char temporary[64];
    snprintf(temporary, sizeof(temporary), ".meta.env.%d.%016" PRIx64, getpid(), nonce);
    const int out = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);

    if (out < 0) {
        return PROBE_UNKNOWN;
    }

    size_t offset = 0;
    while (offset < length) {
        const ssize_t count = write(out, bytes + offset, length - offset);

        if (count <= 0) {
            break;
        }
        offset += (size_t)count;
    }

    const bool written = offset == length && fchmod(out, 0600) == 0 && fsync(out) == 0;
    const int closed = close(out);
    if (!written || closed != 0 || renameat(fd, temporary, fd, "meta.env") != 0) {
        unlinkat(fd, temporary, 0);
        return PROBE_UNKNOWN;
    }

    return fsync(fd) == 0 ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * Читает первую bounded строку с позиции 0 и сохраняет смещение родительского FD.
 * Уже удалённый временный файл остаётся валидным capability через удержанный FD.
 */
static enum probe_status status_token(int fd)
{
    struct stat token;

    if (fstat(fd, &token) != 0) {
        return errno == EBADF ? PROBE_DEAD : PROBE_UNKNOWN;
    }

    if (!S_ISREG(token.st_mode) || token.st_uid != getuid() || (token.st_mode & 07777) != 0600
        || token.st_nlink > 1 || token.st_size <= 0 || token.st_size > 4096) {
        return PROBE_UNKNOWN;
    }

    char value[4096];
    const ssize_t length = pread(fd, value, sizeof(value), 0);

    if (length != token.st_size) {
        return PROBE_UNKNOWN;
    }

    const char *newline = memchr(value, '\n', (size_t)length);

    if (newline != value + length - 1 || newline == value
        || memchr(value, '\0', (size_t)length) != NULL) {
        return PROBE_UNKNOWN;
    }

    return fwrite(value, 1, (size_t)length, stdout) == (size_t)length ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * UUID принадлежит текущему boot session. Проверяет форму до вывода.
 * Python и Bash получают одну строку без путей и прочих sysctl данных.
 */
static enum probe_status print_boot_id(void)
{
    char value[37] = {0};
    size_t length = sizeof(value);

    if (sysctlbyname("kern.bootsessionuuid", value, &length, NULL, 0) != 0
        || length != sizeof(value) || value[36] != '\0') {
        return PROBE_UNKNOWN;
    }

    for (size_t index = 0; index < 36; index++) {
        char glyph = value[index];

        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (glyph != '-') {
                return PROBE_UNKNOWN;
            }

            continue;
        }

        if (glyph >= 'A' && glyph <= 'F') {
            glyph += 'a' - 'A';
        } else if ((glyph < 'a' || glyph > 'f') && (glyph < '0' || glyph > '9')) {
            return PROBE_UNKNOWN;
        }

        value[index] = glyph;
    }

    return puts(value) < 0 ? PROBE_UNKNOWN : PROBE_OK;
}

static bool valid_task(const char *task)
{
    const size_t length = strlen(task);

    return length > 0 && length <= 19 && task[0] != '0' && strspn(task, "0123456789") == length;
}

#include "runner-fds.h"

/*
 * Kernel lease крепится к унаследованному open file description. Закрытие
 * помощника не снимает lease, пока исходный descriptor удерживает родитель.
 */
static enum probe_status acquire_install_lock(int fd)
{
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1
        || info.st_uid != geteuid() || (info.st_mode & 07777) != 0600) {
        return PROBE_UNKNOWN;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        return errno == EWOULDBLOCK ? PROBE_BUSY : PROBE_UNKNOWN;
    }
    return PROBE_OK;
}

/*
 * Публикация staging атомарна и никогда не заменяет каталог,
 * появившийся по конечному имени после проверки.
 */
static enum probe_status publish_install_stage(int fd, const char *stage, const char *target)
{
    const size_t prefix = strlen(target);
    struct stat parent, source;
    if (prefix == 0 || prefix >= NAME_MAX || strlen(stage) > NAME_MAX
        || strchr(target, '/') || strchr(stage, '/') || strcmp(target, ".") == 0 || strcmp(target, "..") == 0
        || strncmp(stage, target, prefix) != 0 || strncmp(stage + prefix, ".install-stage.", 15) != 0
        || fstat(fd, &parent) != 0 || !S_ISDIR(parent.st_mode)
        || fstatat(fd, stage, &source, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(source.st_mode)
        || source.st_uid != geteuid() || (source.st_mode & 07777) != 0700) {
        return PROBE_UNKNOWN;
    }
    if (renameatx_np(fd, stage, fd, target, RENAME_EXCL) != 0) {
        return errno == EEXIST ? PROBE_BUSY : PROBE_UNKNOWN;
    }
    return PROBE_OK;
}

/*
 * Moves one proven lock inode within a checked parent. The caller keeps the
 * sibling kernel guard open until the entire directory transaction finishes.
 */
static enum probe_status move_lock_directory(int fd, const char *source, const char *target,
    const char *device_text, const char *inode_text)
{
    struct stat directory, entry;
    char *end;
    errno = 0;
    const uintmax_t device = strtoumax(device_text, &end, 10);
    if (errno != 0 || *end || end == device_text) {
        return PROBE_USAGE;
    }
    const uintmax_t inode = strtoumax(inode_text, &end, 10);
    if (errno != 0 || *end || end == inode_text || source[0] == '\0' || target[0] == '\0'
        || strlen(source) > NAME_MAX || strlen(target) > NAME_MAX || strchr(source, '/') || strchr(target, '/')
        || strcmp(source, ".") == 0 || strcmp(source, "..") == 0
        || strcmp(target, ".") == 0 || strcmp(target, "..") == 0
        || fstat(fd, &directory) != 0 || !S_ISDIR(directory.st_mode)
        || directory.st_uid != geteuid() || (directory.st_mode & 0022) != 0
        || fstatat(fd, source, &entry, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(entry.st_mode)
        || entry.st_uid != geteuid() || (entry.st_mode & 07777) != 0700
        || (uintmax_t)entry.st_dev != device || (uintmax_t)entry.st_ino != inode) {
        return PROBE_UNKNOWN;
    }
    if (renameatx_np(fd, source, fd, target, RENAME_EXCL) != 0) {
        return errno == EEXIST ? PROBE_BUSY : PROBE_UNKNOWN;
    }
    return fsync(fd) == 0 ? PROBE_OK : PROBE_UNKNOWN;
}

/*
 * Ищет только собственные инкарнации с точно указанным executable. При
 * невозможности прочитать живого участника не выдаётся пустой результат.
 */
static enum probe_status installed_desktop_census(const char *expected)
{
    if (expected[0] != '/' || strlen(expected) >= PROC_PIDPATHINFO_MAXSIZE) {
        return PROBE_USAGE;
    }

    size_t count = 0;
    struct census_row *rows = collect_census(&count);
    if (rows == NULL) {
        return PROBE_UNKNOWN;
    }
    pid_t *matches = calloc(count ? count : 1, sizeof(*matches));
    if (matches == NULL) {
        free(rows);
        return PROBE_UNKNOWN;
    }

    size_t size = 0;
    enum probe_status result = PROBE_OK;
    for (size_t index = 0; index < count; index++) {
        const pid_t pid = (pid_t)rows[index].info.pbi_pid;
        char executable[PROC_PIDPATHINFO_MAXSIZE];
        struct proc_bsdinfo confirmed;
        const int bytes = proc_pidpath(pid, executable, sizeof(executable));
        const enum probe_status probe = read_process(pid, &confirmed);
        if (probe == PROBE_DEAD) {
            continue;
        }
        if (bytes <= 0 || probe != PROBE_OK || !same_start(&confirmed, &rows[index].info)) {
            result = PROBE_UNKNOWN;
            break;
        }
        if (strcmp(executable, expected) == 0) {
            matches[size++] = pid;
        }
    }

    if (result == PROBE_OK) {
        printf("[");
        for (size_t index = 0; index < size; index++) {
            printf("%s%d", index ? "," : "", matches[index]);
        }
        printf("]\n");
    }
    free(matches);
    free(rows);
    return result;
}

/*
 * Принимает закрытые команды чтения и проверяет числовой вход до обращений к ядру.
 * Вызывающий не передаёт произвольный pathname для чтения.
 */
int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "install-lock") == 0) {
        return acquire_install_lock(3);
    }

    if (argc == 4 && strcmp(argv[1], "publish-install-stage") == 0) {
        return publish_install_stage(3, argv[2], argv[3]);
    }

    if (argc == 6 && strcmp(argv[1], "move-lock-directory") == 0) {
        return move_lock_directory(3, argv[2], argv[3], argv[4], argv[5]);
    }

    if (argc == 3 && strcmp(argv[1], "installed-desktop-census") == 0) {
        return installed_desktop_census(argv[2]);
    }

    if (argc == 9 && strcmp(argv[1], "runner-fd-hold") == 0) {
        return hold_runner_fds(argv);
    }

    if (argc >= 5 && strcmp(argv[1], "runner-fd-exec") == 0) {
        return exec_runner_fds(argv);
    }

    if (argc == 2 && strcmp(argv[1], "boot-id") == 0) {
        return print_boot_id();
    }

    if (argc == 2 && strcmp(argv[1], "uid-census") == 0) {
        return print_census();
    }

    if (argc == 2 && strcmp(argv[1], "quiesce-bound-runner") == 0) {
        return quiesce_bound_runner(3, 4, 5, 6);
    }

    if (argc == 3 && strcmp(argv[1], "verify-task-lock") == 0) {
        return verify_task_lock(3, 4, argv[2]);
    }

    if ((argc != 3 && argc != 4 && argc != 5 && argc != 7) || argv[2][0] < '1' || argv[2][0] > '9') {
        return PROBE_USAGE;
    }

    char *end = NULL;
    errno = 0;
    const long number = strtol(argv[2], &end, 10);

    if (errno != 0 || *end != '\0' || number <= 0 || number > INT_MAX) {
        return PROBE_USAGE;
    }

    if (argc == 3 && strcmp(argv[1], "identity") == 0) {
        return print_identity((pid_t)number);
    }

    if (argc == 3 && strcmp(argv[1], "status-token") == 0) {
        return status_token((int)number);
    }

    if (argc == 3 && strcmp(argv[1], "run-events-stat") == 0) {
        return run_events_stat((int)number);
    }

    if (argc == 3 && strcmp(argv[1], "runner-fd-stat") == 0) {
        return runner_fd_stat((int)number);
    }

    if (argc == 3 && strcmp(argv[1], "sync-runner-fd") == 0) {
        return sync_runner_fd((int)number);
    }

    if (argc == 3 && strcmp(argv[1], "sync-tx-state") == 0 && private_run_directory((int)number)) {
        return sync_restored_object((int)number, "file", "state.env");
    }

    if (argc == 4 && strcmp(argv[1], "clear-tx-pointer") == 0) {
        return clear_tx_pointer((int)number, argv[3]);
    }

    if (argc == 5 && strcmp(argv[1], "sync-restored-object") == 0) {
        return sync_restored_object((int)number, argv[3], argv[4]);
    }

    if (argc == 3 && strcmp(argv[1], "write-run-meta") == 0) {
        return write_run_meta((int)number);
    }

    if (argc == 4 && strcmp(argv[1], "factory-owner") == 0 && valid_task(argv[3])) {
        return inspect_factory((pid_t)number, argv[3]);
    }

    if (argc == 7 && strcmp(argv[1], "signal-stage-member") == 0) {
        return signal_stage_member((pid_t)number, argv[3], argv[4], argv[5], argv[6]);
    }

    return PROBE_USAGE;
}
