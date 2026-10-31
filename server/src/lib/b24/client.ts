// Клиент к порталу Битрикс24 (адрес портала — из настроек GrigDesk).
//
// Авторизация — как в браузере: POST формы логина /salary/?login=yes отдаёт
// сессионные куки (BITRIX_SM_*, PHPSESSID), дальше все запросы идут с этими
// куками. USER_REMEMBER=Y делает сессию долгоживущей. REST-токен/вебхук НЕ
// используются — прав на их создание в портале нет.

import { join } from 'node:path';
import { currentB24Read } from './readOperations.ts';
import { CookieJar } from './cookieJar.ts';
import { describeStatus } from './status.ts';
import { fetchTaskMedia } from './media.ts';
import {
    detectMime,
    readFileSource,
    DISK_UPLOADER_CONTROLLER,
    UPLOAD_CHUNK_SIZE,
} from './upload.ts';

// UA как у обычного браузера — чтобы портал не отбивал запрос как бота.
const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Случайная строка для клиентских id (EXEMPLAR_ID/OPERATION_ID) в форме комментария.
function randStr(n: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < n; i += 1) {
        s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return s;
}

/**
 * Лёгкая чистка HTML до читаемого текста (для текста комментариев со страницы).
 * Сохраняет имена @-упоминаний (текст ссылок), переносы строк из <br>/</p>.
 */
function htmlToText(s: unknown): string {
    return String(s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Возвращает внутренний HTML <div> с заданным id, корректно учитывая вложенные
 * <div> (подсчёт глубины). Нужен для извлечения текста комментария, который сам
 * содержит вложенные div'ы — обрезка по «первому </div>» сломала бы его.
 */
function extractDivById(html: string, id: string): string | null {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) {
        return null;
    }
    const open = html.indexOf('>', at);
    if (open < 0) {
        return null;
    }
    const startInner = open + 1;
    let depth = 1;
    const re = /<div\b|<\/div>/gi;
    re.lastIndex = startInner;
    let m: RegExpExecArray | null;

    while ((m = re.exec(html))) {
        depth += m[0][1] === '/' ? -1 : 1;
        if (depth === 0) {
            return html.slice(startInner, m.index);
        }
    }
    return null;
}

// Приоритет задачи в Битриксе: 0 низкий, 1 средний, 2 высокий. Приходит из HTTP-тела,
// поэтому может быть строкой («2») или словом. Мусор НЕ глотаем молча: незамеченное
// поле = задача без приоритета при полной уверенности человека, что он его выставил.
const PRIORITY_ALIASES: Record<string, number> = {
    низкий: 0,
    низкая: 0,
    low: 0,
    средний: 1,
    средняя: 1,
    обычный: 1,
    обычная: 1,
    normal: 1,
    average: 1,
    высокий: 2,
    высокая: 2,
    важная: 2,
    high: 2,
};

function normalizePriority(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const alias = PRIORITY_ALIASES[String(value).trim().toLowerCase()];
    const num = alias ?? Number(value);
    if (![0, 1, 2].includes(num)) {
        throw new Error(`Неверный приоритет «${value}»: жду 0 (низкий), 1 (средний) или 2 (высокий)`);
    }
    return num;
}

const TASK_UPDATE_FIELDS = new Set([
    'title',
    'description',
    'groupId',
    'responsibleId',
    'priority',
]);

export class B24ValidationError extends Error {
    readonly code = 'b24_bad_request';

    constructor(message: string) {
        super(message);
        this.name = 'B24ValidationError';
    }
}

/**
 * Приводит идентификатор задачи или пользователя к положительному safe integer.
 * Строки из route params допустимы, но дроби, пробелы внутри и ноль отвергаются.
 */
function positiveId(value: unknown, label: string): number {
    const text = typeof value === 'string' ? value.trim() : value;
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0 || (typeof text === 'string' && !/^\d+$/.test(text))) {
        throw new B24ValidationError(`${label}: нужно положительное целое число`);
    }
    return id;
}

/**
 * Валидирует узкий публичный контракт редактирования. Поля остаются частичными:
 * отсутствующее поле не уходит в портал и не затирает параллельно изменённое значение.
 */
export function normalizeTaskUpdateFields(value: unknown): Payload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new B24ValidationError('Поля задачи должны быть объектом');
    }

    const raw = value as Payload;
    const keys = Object.keys(raw);
    const unknown = keys.filter((key) => !TASK_UPDATE_FIELDS.has(key));
    if (unknown.length) {
        throw new B24ValidationError(`Неизвестные поля задачи: ${unknown.join(', ')}`);
    }
    if (!keys.length) {
        throw new B24ValidationError('Не передано ни одного изменения задачи');
    }

    const fields: Payload = {};
    if (Object.hasOwn(raw, 'title')) {
        if (typeof raw.title !== 'string' || !raw.title.trim()) {
            throw new B24ValidationError('Заголовок задачи не может быть пустым');
        }
        fields.title = raw.title.trim();
    }
    if (Object.hasOwn(raw, 'description')) {
        if (typeof raw.description !== 'string') {
            throw new B24ValidationError('Описание задачи должно быть строкой');
        }
        fields.description = raw.description;
    }
    if (Object.hasOwn(raw, 'groupId')) {
        fields.groupId = raw.groupId === null || raw.groupId === '' || Number(raw.groupId) === 0
            ? null
            : positiveId(raw.groupId, 'Проект');
    }
    if (Object.hasOwn(raw, 'responsibleId')) {
        fields.responsibleId = positiveId(raw.responsibleId, 'Исполнитель');
    }
    if (Object.hasOwn(raw, 'priority')) {
        let priority: number | null;

        try {
            priority = normalizePriority(raw.priority);
        } catch (error) {
            throw new B24ValidationError(String(
                (error as { message?: unknown } | null)?.message || error,
            ));
        }
        if (priority === null) {
            throw new B24ValidationError('Приоритет задачи не может быть пустым');
        }
        fields.priority = priority;
    }
    return fields;
}

// Свободная запись портала: форму ответов задаёт сам Битрикс, и общего типа у них нет.
type Payload = Record<string, unknown>;

// Сотрудник портала для выбора исполнителя. Должность бывает пустой — это не отказ.
export interface B24User {
    id: number;
    name: string;
    position: string;
}

// Новая задача, какой её описывает вызывающий. Приоритет и адресаты необязательны:
// портал подставит своё, а приоритет проверяется до логина и загрузки вложений.
export interface NewTask {
    title?: string;
    description?: string;
    groupId?: unknown;
    responsibleId?: unknown;
    createdById?: unknown;
    priority?: unknown;
    images?: UploadSource[];
}

// Поля запроса `tasks.task.add` после проверки: вложения уже на диске портала.
export interface TaskAddFields {
    title?: unknown;
    description?: unknown;
    groupId?: unknown;
    responsibleId?: unknown;
    createdById?: unknown;
    priority?: number | null;
    fileIds?: string[];
}

// Источник загружаемого файла: путь на диске либо готовые байты с именем.
export type UploadSource = string | {
    path?: string;
    buffer?: Buffer;
    base64?: string;
    name?: string;
};

/** Вложенная запись ответа: отсутствующая ветка — пустая, а не отказ разбора. */
function nested(value: unknown, key: string): Payload {
    const source = value as Payload | null;
    const child = source?.[key];

    return child && typeof child === 'object' && !Array.isArray(child) ? child as Payload : {};
}

/** Список записей из ответа: чужой формат на этом месте даёт пустой список. */
function nestedList(value: unknown, key: string): Payload[] {
    const child = (value as Payload | null)?.[key];

    return Array.isArray(child) ? child as Payload[] : [];
}

/**
 * Ответ портала как запись. Портал всегда отвечает объектом; массив или строка на
 * этом месте означают, что мы попали не туда (страница логина, ошибка шлюза), и
 * молча продолжать разбор нельзя.
 */
function asPayload(value: unknown): Payload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Портал ответил не объектом JSON.');
    }

    return value as Payload;
}

export interface B24ClientOptions {
    // Адрес портала, например https://b24.example.com
    baseUrl: string;
    login: string;
    password: string;
    // Куда складывать куки между запусками; null — держать только в памяти.
    cookiePath?: string | null;
    // Жёстко заданный номер пользователя вместо обнаружения.
    userId?: number | null;
    mediaDir?: string | null;
}

export class B24Client {
    readonly baseUrl: string;

    readonly login: string;

    readonly password: string;

    readonly jar: CookieJar;

    userId: number | null;

    readonly mediaDir: string | null;

    // Токен сессии портала: живёт до ротации и добывается со страницы.
    sessid: string | null;

    // Кеши списков: портал отдаёт их медленно, а меняются они редко.
    private _groups?: unknown;

    private _users?: B24User[];

    constructor({
        baseUrl,
        login,
        password,
        cookiePath = null,
        userId = null,
        mediaDir = null,
    }: B24ClientOptions) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.login = login;
        this.password = password;
        this.jar = new CookieJar(cookiePath);
        this.userId = userId;
        this.mediaDir = mediaDir;
        this.sessid = null;
    }

    /**
     * Абсолютный URL из пути.
     */
    url(path: string): string {
        return path.startsWith('http') ? path : this.baseUrl + path;
    }

    /**
     * Общий signal чтения охватывает заголовки и последующее потребление тела fetch.
     * Вне контекста чтения правила существующих операций и повторов сохраняются.
     */
    async raw(path: string, { method = 'GET', headers = {}, body = null }: {
        method?: string;
        headers?: Record<string, string>;
        body?: BodyInit | null;
    } = {}): Promise<Response> {
        const read = currentB24Read();
        let lastErr;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            read?.signal.throwIfAborted();

            const started = performance.now();

            read?.trace({
                operation: read.operation,
                phase: 'request',
                attempt: attempt + 1,
            });

            try {
                const res = await fetch(this.url(path), {
                    method,
                    redirect: 'manual',
                    headers: {
                        'User-Agent': USER_AGENT,
                        Cookie: this.jar.header(),
                        ...headers,
                    },
                    body,
                    ...(read ? { signal: read.signal } : {}),
                });

                read?.trace({
                    operation: read.operation,
                    phase: 'headers',
                    attempt: attempt + 1,
                    status: res.status,
                    ms: performance.now() - started,
                });
                read?.signal.throwIfAborted();
                this.jar.absorb(res.headers.getSetCookie?.() ?? []);

                return res;
            } catch (error) {
                if (read?.signal.aborted) {
                    throw read.signal.reason;
                }

                lastErr = error;
            }
        }

        throw lastErr;
    }

    /**
     * Выполняет вход. Бросает исключение, если после логина проба не подтверждает сессию.
     */
    async doLogin(): Promise<boolean> {
        // Сессия меняется — старый sessid (CSRF) больше не валиден.
        this.sessid = null;
        const form = new URLSearchParams({
            AUTH_FORM: 'Y',
            TYPE: 'AUTH',
            backurl: '/salary/?project_id=0',
            USER_LOGIN: this.login,
            USER_PASSWORD: this.password,
            USER_REMEMBER: 'Y',
        });

        let res = await this.raw('/salary/?login=yes&project_id=0', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: this.baseUrl,
                Referer: this.baseUrl + '/salary/?project_id=0',
            },
            body: form.toString(),
        });

        // Битрикс может ответить 302 на backurl — пройдём по редиректам, собирая куки.
        let hops = 0;
        while (res.status >= 300 && res.status < 400 && hops < 5) {
            const loc = res.headers.get('location');
            if (!loc) {
                break;
            }
            res = await this.raw(loc, { method: 'GET' });
            hops += 1;
        }

        const ok = await this.isAuthed();
        if (!ok) {
            this.jar.clear();
            throw new Error(
                'Логин не удался: портал не подтвердил сессию. Проверь B24_LOGIN/B24_PASSWORD ' +
                '(или на форме появилась капча/2FA).',
            );
        }
        this.jar.persist();
        return true;
    }

    /**
     * Лёгкая проба: залогинены ли мы. /local/ajax/notifications.php?action=count
     * для авторизованного отдаёт {"success":true,"count":N}, для гостя — не JSON/редирект.
     */
    async isAuthed(): Promise<boolean> {
        try {
            const res = await this.raw('/local/ajax/notifications.php?action=count');
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                return false;
            }
            const data = await res.json();
            return data?.success === true;
        } catch {
            return false;
        }
    }

    /**
     * Гарантирует валидную сессию: если куки пустые или проба не прошла — логинится.
     */
    async ensureAuth(): Promise<void> {
        if (!this.jar.isEmpty() && (await this.isAuthed())) {
            return;
        }
        await this.doLogin();
    }

    /**
     * Авторизованный GET с автоматическим перелогином при протухшей сессии.
     * Возвращает уже распарсенный JSON (если ответ — JSON), иначе текст.
     * @param {boolean} retry внутренний флаг, чтобы не зациклить перелогин
     */
    async apiGet(path: string, retry = true): Promise<unknown> {
        await this.ensureAuth();
        const res = await this.raw(path);
        const ct = res.headers.get('content-type') || '';

        // Сессия протухла между ensureAuth и запросом — портал вернул HTML логина.
        if (!ct.includes('application/json')) {
            if (retry) {
                await this.doLogin();
                return this.apiGet(path, false);
            }
            const text = await res.text();
            throw new Error(`Ожидался JSON, получен ${ct || 'unknown'} (HTTP ${res.status}). Похоже, сессия не авторизована.`);
        }
        return res.json();
    }

    /**
     * Пытается определить собственный user_id со страницы дашборда.
     * На странице JS дёргает dashboard.php?...user_id=NN — оттуда и берём.
     */
    async discoverUserId(): Promise<number | null> {
        if (this.userId) {
            return this.userId;
        }
        await this.ensureAuth();
        const res = await this.raw('/salary/?project_id=0');
        const html = await res.text();
        // Порядок важен: ссылка на профиль и var USER_ID дают чистый id,
        // а user_id=<n> в коде страницы встречается ещё и как дефолт user_id=0 — он последний.
        const patterns = [
            /\/personal\/user\/(\d+)\//,
            /USER_ID["'\s:=]{1,4}(\d+)/,
            /user_id["'=:\s]{1,4}(\d+)/i,
        ];
        for (const re of patterns) {
            for (const m of html.matchAll(new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
                const id = Number(m[1]);
                if (id > 0) {
                    this.userId = id;
                    return this.userId;
                }
            }
        }
        return null;
    }

    /**
     * Сводка статуса: залогинены ли, кто, сколько уведомлений. Используется как health-check.
     */
    async status(): Promise<Payload> {
        await this.ensureAuth();
        const notif = await this.apiGet('/local/ajax/notifications.php?action=count');
        const userId = await this.discoverUserId();
        return {
            authorized: true,
            login: this.login,
            userId,
            notifications: (notif as { count?: unknown } | null)?.count ?? null,
        };
    }

    // ==================== ЗАДАЧИ ====================

    /**
     * Достаёт CSRF-токен (bitrix_sessid) со страницы дашборда. Нужен для пишущих
     * действий (таймер). Кешируется; force=true — перечитать (после перелогина/протухания).
     */
    async getSessid(force = false): Promise<string | null> {
        if (this.sessid && !force) {
            return this.sessid;
        }
        await this.ensureAuth();
        const html = await (await this.raw('/salary/?project_id=0')).text();
        const m = html.match(/bitrix_sessid"?\s*:\s*"([a-f0-9]+)"/);
        this.sessid = m?.[1] ?? null;
        return this.sessid;
    }

    /**
     * Нормализует «сырую» задачу из getTodayData в компактный вид и навешивает
     * семантику статуса (что значит / чьё действие) относительно myId.
     */
    mapTask(t: Payload, myId: number): Payload {
        const mapped: Payload = {
            id: t.id,
            title: t.title,
            group: t.group_name || '',
            groupId: t.group_id ?? null,
            // custom_priority: 1..N — ручной порядок; 0/пусто — ручного приоритета нет.
            cp: Number(t.custom_priority) > 0 ? t.custom_priority : null,
            priority: t.priority ?? 0,
            priorityLabel: t.priority_label || '',
            flame: !!t.has_flame,
            status: t.status,
            statusLabel: t.status_label || '',
            deadline: t.deadline || '',
            deadlineRaw: t.deadline_raw || '',
            overdue: !!t.is_overdue,
            unread: t.unread_comments ?? 0,
            checklistDone: t.checklist_completed ?? 0,
            checklistTotal: t.checklist_total ?? 0,
            timerRunning: !!t.timer_running,
            timerElapsed: t.timer_elapsed ?? 0,
            responsibleId: t.responsible_id ?? null,
            responsible: t.responsible_name || '',
            creatorId: t.creator_id ?? null,
            creator: t.creator_name || '',
            url: t.url || '',
        };
        const st = describeStatus(mapped, myId);
        mapped.statusKind = st.kind;
        mapped.statusText = st.label;
        mapped.statusHint = st.hint;
        mapped.statusIcon = st.icon;
        mapped.actionable = st.actionable;
        return mapped;
    }

    /**
     * Сравнение задач «по приоритету» для удобного триажа:
     * сперва требующие моего действия (actionable), затем — вручную
     * приоритизированные (custom_priority по возрастанию), горящие (flame),
     * просроченные, по убыванию priority, по дедлайну, по id.
     * «Сдано — ждёт приёмки постановщиком» (не моё действие) уходит вниз.
     */
    static comparePriority(a: Payload, b: Payload): number {
        if (a.actionable !== b.actionable) {
            return a.actionable ? -1 : 1;
        }
        // Ручной порядок: меньше — выше. Задача без него уходит в конец группы.
        const acp = Number(a.cp ?? Infinity);
        const bcp = Number(b.cp ?? Infinity);

        if (acp !== bcp) {
            return acp - bcp;
        }
        if (a.flame !== b.flame) {
            return a.flame ? -1 : 1;
        }
        if (a.overdue !== b.overdue) {
            return a.overdue ? -1 : 1;
        }
        if (a.priority !== b.priority) {
            return Number(b.priority) - Number(a.priority);
        }

        // Задача без срока считается самой дальней: «9999» больше любой даты.
        const ad = String(a.deadlineRaw || '9999');
        const bd = String(b.deadlineRaw || '9999');

        if (ad !== bd) {
            return ad < bd ? -1 : 1;
        }

        return Number(a.id) - Number(b.id);
    }

    /**
     * Список задач, отсортированный по приоритету.
     * @param {object} opts
     * @param {boolean} opts.all true — все активные задачи, false — приоритизированный набор
     */
    async listTasks({ all = true }: { all?: boolean } = {}): Promise<Payload[]> {
        const uid = (await this.discoverUserId()) ?? 0;
        const flag = all ? 1 : 0;
        const data = await this.apiGet(
            `/local/ajax/dashboard.php?action=getTodayData&user_id=${uid}&project_id=0&show_all_tasks=${flag}`,
        );
        const tasks = nestedList(nested(data, 'data'), 'currentTasks')
            .map((t) => this.mapTask(t, uid));

        tasks.sort(B24Client.comparePriority);

        return tasks;
    }

    /**
     * Итоги текущего месяца из `getData.mainData`. Ряд графика `day.tasks` для
     * этого не подходит: одна задача может попасть в несколько дней учёта времени.
     */
    async getMonthStats(sourceMainData?: unknown): Promise<Payload> {
        let mainData = sourceMainData && typeof sourceMainData === 'object' && !Array.isArray(sourceMainData)
            ? sourceMainData as Payload
            : {};

        if (sourceMainData === undefined) {
            const uid = (await this.discoverUserId()) ?? 0;
            const response = await this.apiGet(
                `/local/ajax/dashboard.php?action=getData&user_id=${uid}&project_id=0&chart_period=day&show_all_tasks=1`,
            );
            mainData = nested(nested(response, 'data'), 'mainData');
        }

        const hours = Number(mainData.worked_hours);
        const completedTasks = Number(mainData.completed_tasks);
        const norm = Number(mainData.min_hours);

        return {
            hours: Number.isFinite(hours) && hours >= 0 ? hours : 0,
            completedTasks: Number.isSafeInteger(completedTasks) && completedTasks >= 0 ? completedTasks : 0,
            norm: Number.isFinite(norm) && norm >= 0 ? norm : null,
        };
    }

    /**
     * Список задач + сводка по отработанному времени (сегодня и за месяц) за один проход.
     * Полный `getData` нужен ради авторитетного `mainData.completed_tasks`.
     * @param {object} opts
     * @param {boolean} opts.all все мои активные задачи (true) или приоритетный набор (false)
     */
    async getDashboard({ all = true }: { all?: boolean } = {}): Promise<Payload> {
        const uid = (await this.discoverUserId()) ?? 0;
        const flag = all ? 1 : 0;
        const data = await this.apiGet(
            `/local/ajax/dashboard.php?action=getData&user_id=${uid}&project_id=0&chart_period=day&show_all_tasks=${flag}`,
        );
        const payload = nested(data, 'data');
        const tasks = nestedList(payload, 'currentTasks').map((t) => this.mapTask(t, uid));

        tasks.sort(B24Client.comparePriority);

        const td = nested(payload, 'todayData');
        const month = await this.getMonthStats(nested(payload, 'mainData'));
        return {
            tasks,
            today: { hours: td.hours ?? 0, tasks: td.tasks_count ?? 0 },
            month,
        };
    }

    /**
     * Проверка номера допускает только доказанное отсутствие задачи.
     * Ошибка сети, доступа или незнакомое тело не делают номер свободным.
     */
    async probeTaskNumber(taskId: string): Promise<'exists' | 'absent' | 'unknown'> {
        try {
            const result = await this.apiGet2(
                '/local/ajax/dashboard.php',
                `action=getTaskDetails&taskId=${encodeURIComponent(taskId)}`,
            );

            // Портал отвечает сообщением из своей локали: кроме русского «Задача не
            // найдена» и кода TASK_NOT_FOUND встречается английское «Task not found».
            // Сравнение — по нормализованной строке, но строгое равенство: «Задача не
            // найдена или нет доступа» остаётся unknown (номер не становится свободным).
            const notFoundError = String(result.error).trim().toLowerCase();
            const notFoundVariants = ['задача не найдена', 'task not found', 'task_not_found'];

            if (result.success === false && notFoundVariants.includes(notFoundError)) {
                return 'absent';
            }

            if (result.success === true && String(nested(result, 'data').id) === taskId) {
                return 'exists';
            }

            return 'unknown';
        } catch {
            return 'unknown';
        }
    }

    /**
     * Полные детали задачи (getTaskDetails).
     */
    async taskDetails(taskId: unknown): Promise<Payload> {
        const data = await this.apiGet2(
            '/local/ajax/dashboard.php',
            `action=getTaskDetails&taskId=${encodeURIComponent(String(taskId))}`,
        );
        if (!data.success) {
            throw new Error(String(data.error || 'Не удалось получить детали задачи'));
        }

        return nested(data, 'data');
    }

    /**
     * Парсит вложения ЗАДАЧИ (поле UF_TASK_WEBDAV_FILES) из HTML страницы задачи.
     * getTaskDetails вложения не отдаёт — берём их со страницы. Файлы задачи лежат
     * в контейнере `<div id="task-detail-files">`; ограничиваем разбор этим блоком
     * (до начала компонента комментариев), чтобы не захватить вложения комментариев.
     * @param {string} html
     * @returns {Array<{attachedId:number,name:string,objectId:number|null,downloadPath:string,isImage:boolean}>}
     */
    static parseTaskAttachments(html: string): Payload[] {
        const start = html.indexOf('id="task-detail-files"');
        if (start < 0) {
            return [];
        }
        // Конец блока — начало секции комментариев (она идёт ниже по странице).
        let end = html.length;
        for (const anchor of ['bitrix:forum.comments', 'task-detail-comments', 'id="comments"']) {
            const i = html.indexOf(anchor, start);
            if (i >= 0 && i < end) {
                end = i;
            }
        }
        return B24Client.parseDiskAttachments(html.slice(start, end));
    }

    /**
     * Разбирает дисковые вложения из произвольного блока HTML (контейнеры
     * `id="disk-attach-<ID>"`). Формат одинаков у вложений задачи
     * (UF_TASK_WEBDAV_FILES) и комментариев (UF_FORUM_MESSAGE_DOC), поэтому общий.
     * Дедуп по attachedId: портал рендерит одну картинку под одним attachedId
     * дважды (превью + полная), без дедупа счётчик вложений задвоится.
     * @param {string} block
     * @returns {Array<{attachedId:number,name:string,objectId:number|null,downloadPath:string,isImage:boolean}>}
     */
    static parseDiskAttachments(block: string): Payload[] {
        const out = [];
        const seen = new Set();
        const re = /id="disk-attach-(\d+)"/g;
        let m;
        while ((m = re.exec(block))) {
            const attachedId = Number(m[1]);
            if (seen.has(attachedId)) {
                continue;
            }
            seen.add(attachedId);
            const win = block.slice(m.index, m.index + 700);
            const name =
                win.match(/alt="([^"]*)"/)?.[1] ||
                win.match(/data-name="([^"]*)"/)?.[1] ||
                `file-${attachedId}`;
            const objectId = win.match(/data-object-id="(\d+)"/)?.[1] ?? null;
            const rawSrc = win.match(/data-src="([^"]*action=download[^"]*)"/)?.[1];
            const downloadPath = (rawSrc || `/bitrix/tools/disk/uf.php?attachedId=${attachedId}&action=download&ncc=1`)
                .replace(/&amp;/g, '&');
            const isImage = /data-viewer-type="image"/.test(win) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
            out.push({ attachedId, name, objectId: objectId ? Number(objectId) : null, downloadPath, isImage });
        }
        return out;
    }

    /**
     * Разбирает комментарии (тред обсуждения) задачи из HTML её страницы (компонент
     * bitrix:forum.comments). getTaskDetails комментарии не отдаёт. Каждый коммент —
     * блок `id="record-TASK_<taskId>-<MID>-cover"` (статус прочтения bx-mpl-read-status
     * old|new, автор, время, текст, вложения). Системные/авто-комментарии (назначение
     * ролей, смена срока, бот-напоминания о просрочке) помечены классом `mpl-comment-aux`.
     * Возвращает в хронологическом порядке (старые → новые), как на странице.
     *
     * Ограничение: парсятся только отрендеренные на странице комментарии. На очень
     * «болтливых» задачах старые подгружаются лениво (AJAX) и сюда не попадут —
     * показываем самые свежие.
     * @param {string} html
     * @param {number|string} taskId
     * @returns {Array<{mid:number,authorId:number|null,author:string,time:string,isSystem:boolean,unread:boolean,text:string,attachments:Array}>}
     */
    static parseTaskComments(html: string, taskId: unknown): Payload[] {
        const start = html.indexOf('task-detail-comments');
        if (start < 0) {
            return [];
        }
        // Ограничиваем разбор секцией комментариев (до JSON-конфига компонента ниже).
        const cfg = html.indexOf('bitrix:forum.comments', start);
        const block = html.slice(start, cfg < 0 ? html.length : cfg);

        // read-status делаем опциональным — на случай, если портал его не проставит.
        const coverRe = new RegExp(
            `id="record-TASK_${taskId}-(\\d+)-cover"(?:[^>]*bx-mpl-read-status="(\\w+)")?`,
            'g',
        );
        const covers = [];
        let c;
        while ((c = coverRe.exec(block))) {
            covers.push({ mid: c[1], read: c[2] || 'old', idx: c.index });
        }

        const out = [];
        for (let i = 0; i < covers.length; i += 1) {
            // Обложка по индексу существует по построению цикла: перебираем ровно её список.
            const cover = covers[i] as { idx: number; mid: string; read?: string };
            const next = covers[i + 1] as { idx: number } | undefined;
            const seg = block.slice(cover.idx, next ? next.idx : block.length);
            const mid = cover.mid;
            const authorId = seg.match(/blog-comment-user-(\d+)/)?.[1] ?? null;
            const author =
                seg.match(/class="feed-com-name[^"]*"[^>]*>([^<]+)<\/span>/)?.[1]?.trim() ||
                seg.match(/feed-author-name[^"]*"[^>]*>([^<]+)</)?.[1]?.trim() ||
                '—';
            const time = seg.match(/class="feed-time feed-com-time"[^>]*>([^<]+)<\/a>/)?.[1]?.trim() || '';
            const isSystem = /mpl-comment-aux/.test(seg);
            const textHtml = extractDivById(seg, `record-TASK_${taskId}-${mid}-text`);
            const text = textHtml ? htmlToText(textHtml) : '';
            const attachments = B24Client.parseDiskAttachments(seg);
            out.push({
                mid: Number(mid),
                authorId: authorId ? Number(authorId) : null,
                author,
                time,
                isSystem,
                unread: cover.read === 'new',
                text,
                attachments,
            });
        }
        return out;
    }

    /**
     * Данные со страницы задачи за ОДИН запрос: вложения задачи + комментарии.
     * getTaskDetails ни того, ни другого не отдаёт — берём со страницы (IFRAME-вид).
     * При недоступности страницы вернётся пустота через .catch у вызывающего.
     * @returns {Promise<{attachments:Array, comments:Array}>}
     */
    async taskPageData(taskId: unknown): Promise<Payload> {
        await this.ensureAuth();
        const uid = (await this.discoverUserId()) ?? 0;
        const html = await (await this.raw(`/company/personal/user/${uid}/tasks/task/view/${taskId}/?IFRAME=Y`)).text();
        return {
            attachments: B24Client.parseTaskAttachments(html),
            comments: B24Client.parseTaskComments(html, taskId),
        };
    }

    /**
     * Скачивает байты вложения по его download-пути (/bitrix/tools/disk/uf.php?attachedId=...).
     * Авторизация по сессии. Возвращает буфер и content-type.
     * @returns {Promise<{buffer:Buffer, contentType:string}>}
     */
    async fetchAttachmentBytes(downloadPath: string): Promise<Payload>{
        await this.ensureAuth();
        const res = await this.raw(downloadPath);
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = (res.headers.get('content-type') || '').split(';')[0]?.trim() ?? '';
        return { buffer, contentType };
    }

    /**
     * Определяет «проект по умолчанию» — самую частую группу среди моих задач
     * (обычно это домен проекта, например example.com). Возвращает { groupId, groupName } или null.
     */
    async resolveDefaultGroup(): Promise<unknown> {
        const tasks = await this.listTasks({ all: true });
        const counts = new Map();
        const names = new Map();
        for (const t of tasks) {
            if (t.groupId) {
                counts.set(t.groupId, (counts.get(t.groupId) || 0) + 1);
                names.set(t.groupId, t.group);
            }
        }
        let best = null;
        for (const [gid, n] of counts) {
            if (!best || n > best.n) {
                best = { groupId: gid, n };
            }
        }
        return best ? { groupId: best.groupId, groupName: names.get(best.groupId) || '' } : null;
    }

    /**
     * Нормализует элементы socialnetwork.api.workgroup.list. Метод отдаёт строки
     * даже для числовых id; наружу GrigDesk держит единый числовой GROUP_ID.
     *
     * @param {Array<object>} items
     * @returns {Array<{id:number,name:string,type:string}>}
     */
    static normalizeGroups(items: unknown): Payload[] {
        const groups = new Map();
        for (const item of Array.isArray(items) ? items : []) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const id = Number(item.id ?? item.ID);
            const name = String(item.name ?? item.NAME ?? '').trim();
            const type = String(item.type ?? item.TYPE ?? 'group').trim().toLowerCase() || 'group';
            if (Number.isSafeInteger(id) && id > 0 && name) {
                groups.set(id, { id, name, type });
            }
        }
        return [...groups.values()].sort((a, b) => (
            a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }) || a.id - b.id
        ));
    }

    /**
     * Проекты/рабочие группы, доступные текущему пользователю для GROUP_ID задачи.
     * REST-токена у установки нет, но штатный socialnetwork component action
     * принимает браузерную сессию и sessid. Навигация у него своя: `nav=page-N-size-50`.
     *
     * @returns {Promise<Array<{id:number,name:string,type:string}>>}
     */
    async listGroups(force = false, retry = true): Promise<unknown> {
        if (this._groups && !force) {
            return this._groups;
        }
        await this.ensureAuth();
        const sessid = await this.getSessid(force);
        if (!sessid) {
            throw new Error('Битрикс24 не вернул sessid для списка проектов');
        }

        const groups = new Map();
        const pageSize = 50;
        for (let page = 1; page <= 100; page += 1) {
            const body = new URLSearchParams({
                'filter[ACTIVE]': 'Y',
                'filter[CLOSED]': 'N',
                'select[0]': 'ID',
                'select[1]': 'NAME',
                'select[2]': 'TYPE',
                'order[NAME]': 'ASC',
                sessid,
            });
            const res = await this.raw(
                `/bitrix/services/main/ajax.php?action=socialnetwork.api.workgroup.list&nav=page-${page}-size-${pageSize}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Bitrix-Csrf-Token': sessid,
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: body.toString(),
                },
            );
            const data = await res.json().catch(() => null);
            if (data?.status !== 'success') {
                const message = (Array.isArray(data?.errors) ? data.errors : [])
                    .map((error: Payload) => error.message)
                    .filter(Boolean)
                    .join('; ');
                if (retry && (!data || /csrf|sessid|sign|авторизац/i.test(message))) {
                    await this.getSessid(true);
                    return this.listGroups(false, false);
                }
                throw new Error(message || 'Не удалось получить проекты Битрикс24');
            }

            const items = Array.isArray(data.data?.workgroups) ? data.data.workgroups : [];
            const before = groups.size;
            for (const group of B24Client.normalizeGroups(items)) {
                groups.set(group.id, group);
            }
            // Короткая страница — последняя. Защита `before` не даёт зациклиться,
            // если старая версия портала вдруг проигнорирует nav и повторит страницу.
            if (items.length < pageSize || (page > 1 && groups.size === before)) {
                break;
            }
        }

        this._groups = [...groups.values()].sort((a, b) => (
            a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }) || a.id - b.id
        ));
        return this._groups;
    }

    /**
     * Ростер пользователей портала (для выбора исполнителя). getAvailableUsers
     * отдаёт весь список (id, name, position, …); фильтрация по имени — на нашей стороне,
     * сервер параметр поиска игнорирует. Результат кешируется на время жизни процесса.
     */
    async listUsers(force = false): Promise<B24User[]> {
        if (this._users && !force) {
            return this._users;
        }
        const data = await this.apiGet2('/local/ajax/dashboard.php', 'action=getAvailableUsers');
        const users = Array.isArray(data.data) ? data.data as Payload[] : [];

        this._users = users.map((u) => ({
            id: Number(u.id),
            name: String(u.name || ''),
            position: String(u.position || ''),
        }));

        return this._users;
    }

    /**
     * Поиск пользователей по имени: совпадают ВСЕ токены запроса (в любом порядке,
     * регистронезависимо), поэтому «Тестов Алексей» и «Алексей Тестов» дадут одно.
     * Пустой запрос — весь ростер.
     */
    async findUsers(query: unknown): Promise<B24User[]> {
        const users = await this.listUsers();
        const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) {
            return users;
        }
        return users.filter((u) => {
            const n = u.name.toLowerCase();

            return tokens.every((t) => n.includes(t));
        });
    }

    /**
     * Загружает один файл на Диск Битрикса через сессионный аплоадер веб-морды
     * (контроллер ui.fileuploader + disk.uf.integration.diskUploaderController).
     * Файл кладётся в «Мой Диск / Загруженные файлы». Подпись не нужна — авторизация
     * по сессии. Возвращает serverFileId вида `n<diskObjectId>` — его подставляют
     * в поля вложений задачи (UF_TASK_WEBDAV_FILES) и комментария (UF_FORUM_MESSAGE_DOC).
     *
     */
    async uploadDiskFile(source: UploadSource, retry = true): Promise<Payload> {
        const src = typeof source === 'string' ? { path: source } : source;
        const { buffer, name } = readFileSource(src);
        if (!buffer.length) {
            throw new Error(`Пустой файл: ${name}`);
        }
        const mime = detectMime(name, buffer);

        await this.ensureAuth();
        const sessid = await this.getSessid();
        const total = buffer.length;

        // Токен переносится между чанками; serverFileId приходит в финальном ответе.
        // Токен и запись файла заполняет вложенная отправка чанка. Держим их в объекте:
        // присваивания внутри замыкания компилятор не отслеживает, и обычная переменная
        // после цикла выглядела бы навсегда пустой.
        const uploadState: { token: string; file: Payload | null } = { token: '', file: null };

        // Отправка одного чанка. single=true — файл влез целиком, шлём без Content-Range
        // (ровно как браузер при offset=0 и size==total).
        const sendChunk = async (offset: number, single: boolean) => {
            const end = Math.min(offset + UPLOAD_CHUNK_SIZE, total);
            const chunk = buffer.subarray(offset, end);
            const headers: Record<string, string> = {
                'Content-Type': mime,
                'X-Upload-Content-Name': encodeURIComponent(name),
                'X-Bitrix-Csrf-Token': sessid || '',
                'X-Requested-With': 'XMLHttpRequest',
            };
            if (!single) {
                headers['Content-Range'] = `bytes ${offset}-${end - 1}/${total}`;
            }
            const qs = new URLSearchParams({
                action: 'ui.fileuploader.upload',
                controller: DISK_UPLOADER_CONTROLLER,
                controllerOptions: '',
                token: uploadState.token,
                sessid: sessid || '',
            });
            const res = await this.raw('/bitrix/services/main/ajax.php?' + qs.toString(), {
                method: 'POST',
                headers,
                body: new Uint8Array(chunk),
            });
            const data = await res.json().catch(() => null) as Payload | null;

            if (data?.status !== 'success') {
                const msg = data?.errorMessage
                    || (Array.isArray(data?.errors) ? data.errors : [])
                        .map((e: Payload) => e.message)
                        .join('; ');
                const text = String(msg || '');
                // Признак «протухла подпись»: по нему вызывающий решает, повторять ли
                // загрузку с новым sessid, а не показывать человеку общий отказ.
                const err = new Error(text || 'Не удалось загрузить файл на диск') as Error & {
                    csrf?: boolean;
                };

                err.csrf = /csrf|sessid|sign/i.test(text);
                throw err;
            }

            const payload = nested(data, 'data');

            if (payload.token) {
                uploadState.token = String(payload.token);
            }
            if (payload.file) {
                uploadState.file = payload.file as Payload;
            }
        };

        try {
            if (total <= UPLOAD_CHUNK_SIZE) {
                await sendChunk(0, true);
            } else {
                for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_SIZE) {
                    await sendChunk(offset, false);
                }
            }
        } catch (e) {
            // Протух CSRF/сессия — обновим sessid и повторим загрузку целиком один раз.
            if (retry && (e as { csrf?: boolean } | null)?.csrf) {
                await this.getSessid(true);
                return this.uploadDiskFile(source, false);
            }
            throw e;
        }

        const uploaded = uploadState.file;

        if (!uploaded?.serverFileId) {
            throw new Error(`Загрузка «${name}» не вернула serverFileId`);
        }

        return {
            id: uploaded.serverFileId,
            name: uploaded.name || name,
            objectId: (uploaded.customData as Payload | null)?.objectId ?? null,
            size: uploaded.size ?? total,
            isImage: !!uploaded.isImage,
            contentType: mime,
        };
    }

    /**
     * Загружает несколько файлов по очереди (см. uploadDiskFile).
     * @param {Array<string|object>} sources
     * @returns {Promise<Array<{id:string,name:string,objectId:number|null,size:number,isImage:boolean,contentType:string}>>}
     */
    async uploadDiskFiles(sources: UploadSource[]): Promise<Payload[]> {
        const out = [];
        for (const s of sources) {
            out.push(await this.uploadDiskFile(s));
        }
        return out;
    }

    /**
     * Создаёт задачу через стандартный AJAX-контроллер Битрикса tasks.task.add.
     * Вложения (images) грузятся на диск ОДИН раз до отправки, их serverFileId
     * подставляются в поле UF_TASK_WEBDAV_FILES создаваемой задачи.
     * @param {object} opts
     * @param {string} opts.title         заголовок (обязателен)
     * @param {string} opts.description   описание (опционально)
     * @param {number|null} opts.groupId  группа/проект (если null — задача без группы)
     * @param {number|null} opts.responsibleId ответственный (если null — я)
     * @param {number|null} opts.createdById постановщик/автор задачи (если null — я)
     * @param {number|string|null} opts.priority приоритет 0/1/2 (или слово: низкий/средний/высокий);
     *                                           null — не трогаем, портал ставит свой по умолчанию
     * @param {Array<string|object>} opts.images пути к файлам/изображениям для прикрепления
     * @returns {Promise<{id:number, group:{id:number,name:string}|null, responsibleId:number, files:Array}>}
     */
    async createTask({
        title,
        description = '',
        groupId = null,
        responsibleId = null,
        createdById = null,
        priority = null,
        images = [],
    }: NewTask): Promise<Payload> {
        if (!title || !title.trim()) {
            throw new Error('Пустой заголовок задачи');
        }
        // Проверяем приоритет ДО логина и загрузки вложений — чтобы опечатка не стоила
        // залитых на диск файлов.
        const prio = normalizePriority(priority);
        await this.ensureAuth();
        const uid = (await this.discoverUserId()) ?? 0;
        // Грузим вложения один раз — вне CSRF-ретраев самого add-запроса.
        const uploaded = images.length ? await this.uploadDiskFiles(images) : [];
        const result = await this.sendTaskAdd({
            title,
            description,
            groupId,
            responsibleId: responsibleId ?? uid,
            createdById,
            priority: prio,
            fileIds: uploaded.map((u) => String(u.id)),
        });
        return { ...(result as Payload), files: uploaded };
    }

    /**
     * Отправляет tasks.task.add с уже готовыми serverFileId вложений.
     * Выделено из createTask, чтобы CSRF-ретрай не перезагружал файлы заново.
     */
    async sendTaskAdd({
        title,
        description,
        groupId,
        responsibleId,
        createdById = null,
        priority = null,
        fileIds,
    }: TaskAddFields, retry = true): Promise<unknown> {
        const sessid = await this.getSessid();
        const body = new URLSearchParams();
        body.set('fields[TITLE]', String(title));
        if (description) {
            body.set('fields[DESCRIPTION]', String(description));
        }
        body.set('fields[RESPONSIBLE_ID]', String(responsibleId));
        // Постановщик/автор. Если не задан — портал ставит создателя сессии (меня).
        if (createdById) {
            body.set('fields[CREATED_BY]', String(createdById));
        }
        if (groupId) {
            body.set('fields[GROUP_ID]', String(groupId));
        }
        // Именно !== null: приоритет 0 (низкий) — валидное значение, обычная проверка на
        // истинность его бы потеряла.
        if (priority !== null) {
            body.set('fields[PRIORITY]', String(priority));
        }
        (fileIds ?? []).forEach((fid, i) => {
            body.set(`fields[UF_TASK_WEBDAV_FILES][${i}]`, fid);
        });
        body.set('sessid', sessid || '');

        const res = await this.raw('/bitrix/services/main/ajax.php?action=tasks.task.add', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Bitrix-Csrf-Token': sessid || '',
            },
            body: body.toString(),
        });
        const data = await res.json().catch(() => null);

        if (data?.status !== 'success') {
            const msg = (data?.errors || []).map((e: Payload) => e.message).join('; ');
            // Протух CSRF — обновим sessid и повторим один раз.
            if (retry && /csrf|sessid|sign/i.test(msg)) {
                await this.getSessid(true);
                return this.sendTaskAdd({ title, description, groupId, responsibleId, createdById, priority, fileIds }, false);
            }
            throw new Error(msg || 'Не удалось создать задачу');
        }
        const task = data.data?.task ?? data.data ?? {};
        const id = Number(task.id ?? task.ID);
        return {
            id,
            group: groupId ? { id: groupId } : null,
            responsibleId: Number(responsibleId),
            createdById: createdById ? Number(createdById) : null,
            priority,
        };
    }

    /**
     * Частично обновляет основные поля задачи. Валидация выполняется до авторизации,
     * поэтому некорректный запрос не тратит сетевой вызов и не меняет сессию портала.
     */
    async updateTask(taskId: unknown, rawFields: unknown): Promise<unknown> {
        const id = positiveId(taskId, 'Задача');
        const fields = normalizeTaskUpdateFields(rawFields);

        await this.ensureAuth();
        return this.sendTaskUpdate(id, fields);
    }

    /**
     * Отправляет tasks.task.update с уже проверенным частичным набором полей.
     * Пустое описание и нулевой GROUP_ID значимы: так описание очищают, а проект снимают.
     */
    async sendTaskUpdate(taskId: unknown, fields: Payload, retry = true): Promise<unknown> {
        const sessid = await this.getSessid();
        const body = new URLSearchParams();
        body.set('taskId', String(taskId));
        if (Object.hasOwn(fields, 'title')) {
            body.set('fields[TITLE]', String(fields.title));
        }
        if (Object.hasOwn(fields, 'description')) {
            body.set('fields[DESCRIPTION]', String(fields.description));
        }
        if (Object.hasOwn(fields, 'groupId')) {
            body.set('fields[GROUP_ID]', String(fields.groupId ?? 0));
        }
        if (Object.hasOwn(fields, 'responsibleId')) {
            body.set('fields[RESPONSIBLE_ID]', String(fields.responsibleId));
        }
        if (Object.hasOwn(fields, 'priority')) {
            body.set('fields[PRIORITY]', String(fields.priority));
        }
        body.set('sessid', sessid || '');

        const res = await this.raw('/bitrix/services/main/ajax.php?action=tasks.task.update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Bitrix-Csrf-Token': sessid || '',
            },
            body: body.toString(),
        });
        const data = await res.json().catch(() => null);

        if (data?.status !== 'success') {
            const msg = (data?.errors || [])
                .map((error: Payload) => error.message)
                .filter(Boolean)
                .join('; ');
            if (retry && /csrf|sessid|sign/i.test(msg)) {
                await this.getSessid(true);
                return this.sendTaskUpdate(taskId, fields, false);
            }
            throw new Error(msg || 'Не удалось обновить задачу');
        }

        const task = data.data?.task ?? data.data ?? {};
        return { ok: true, id: Number(task.id ?? task.ID ?? taskId) };
    }

    /**
     * Удаляет задачу через стандартный контроллер tasks.task.delete.
     * Действие необратимое (задача уходит в корзину/удаляется).
     */
    async deleteTask(taskId: unknown, retry = true): Promise<unknown> {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const res = await this.raw('/bitrix/services/main/ajax.php?action=tasks.task.delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Bitrix-Csrf-Token': sessid || '',
            },
            body: `taskId=${encodeURIComponent(String(taskId))}&sessid=${encodeURIComponent(sessid || '')}`,
        });
        const data = await res.json().catch(() => null);
        if (data?.status !== 'success') {
            const msg = (data?.errors || []).map((e: Payload) => e.message).join('; ');
            if (retry && /csrf|sessid|sign/i.test(msg)) {
                await this.getSessid(true);
                return this.deleteTask(taskId, false);
            }
            throw new Error(msg || 'Не удалось удалить задачу');
        }
        return { ok: true };
    }

    /**
     * Извлекает signedParameters (подписанный сервером блок) формы комментариев
     * со страницы задачи. Ключ в JSON-конфиге компонента — "params"; значение
     * экранировано (\/), читаем посимвольно до закрывающей кавычки с разэкранированием.
     * Подпись после точки сохраняем — без неё сервер отклонит.
     */
    static extractCommentSignedParams(html: string): string | null {
        const anchor = html.indexOf('bitrix:forum.comments');
        if (anchor < 0) {
            return null;
        }
        const key = '"params":"';
        const i = html.indexOf(key, anchor);
        if (i < 0) {
            return null;
        }
        let j = i + key.length;
        let out = '';
        while (j < html.length) {
            const ch = html[j];
            if (ch === '\\') {
                out += html[j + 1] ?? '';
                j += 2;
                continue;
            }
            if (ch === '"') {
                break;
            }
            out += ch;
            j += 1;
        }
        return out || null;
    }

    /**
     * Добавляет комментарий к задаче через компонент bitrix:forum.comments.
     * Опционально прикрепляет изображения/файлы (images) — они грузятся на диск
     * ОДИН раз и привязываются полем UF_FORUM_MESSAGE_DOC. ВНИМАНИЕ: форум требует
     * непустой текст — комментарий только с вложением сервер отклоняет.
     * signedParameters берём со страницы задачи. Комментарий уведомляет всех участников.
     *
     * Текст обязателен даже при вложениях — форум портала пустой не принимает.
     */
    async addComment(taskId: unknown, text: unknown, { images = [] }: {
        images?: UploadSource[];
    } = {}): Promise<Payload> {
        const message = String(text ?? '');

        if (!message.trim()) {
            throw new Error('Пустой комментарий');
        }

        // Грузим вложения один раз — вне CSRF-ретраев самой отправки комментария.
        const uploaded = images.length ? await this.uploadDiskFiles(images) : [];
        const r = await this.sendComment(taskId, message, uploaded.map((u) => String(u.id)));

        return { ...(r as Payload), files: uploaded };
    }

    /**
     * Отправляет processComment с уже готовыми serverFileId вложений.
     * Выделено из addComment, чтобы перелогин/CSRF-ретрай не перезагружал файлы.
     */
    async sendComment(
        taskId: unknown,
        text: string,
        fileIds: string[] = [],
        retry = true,
    ): Promise<unknown> {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const uid = (await this.discoverUserId()) ?? 0;
        const refererPath = `/company/personal/user/${uid}/tasks/task/view/${taskId}/?IFRAME=Y`;
        const page = await (await this.raw(refererPath)).text();

        const signed = B24Client.extractCommentSignedParams(page);
        if (!signed) {
            // Возможно протухла сессия и вернулась страница логина — перелогин + повтор.
            if (retry) {
                await this.doLogin();
                return this.sendComment(taskId, text, fileIds, false);
            }
            throw new Error('Не удалось получить signedParameters со страницы задачи (нет доступа к задаче?)');
        }
        const exemplar =
            page.match(/EXEMPLAR_ID['"]?\s*[:=]\s*['"]([A-Za-z0-9_]+)/)?.[1] || `${uid}_${randStr(8)}`;

        const body = new URLSearchParams({
            ENTITY_XML_ID: `TASK_${String(taskId)}`,
            ENTITY_TYPE: 'TK',
            ENTITY_ID: String(taskId),
            sessid: sessid || '',
            REVIEW_USE_SMILES: 'Y',
            comment_review: 'Y',
            REVIEW_TEXT: text,
            FORUM_MESSAGE_DISK_ATTACHED_OBJECT_TEMPLATE_VIEW: 'grid',
            IS_TASK_RESULT_FORM: 'Y',
            NOREDIRECT: 'Y',
            MODE: 'RECORD',
            AJAX_POST: 'Y',
            SITE_ID: 's1',
            LANGUAGE_ID: 'ru',
            ACTION: 'ADD',
            signedParameters: String(signed),
            EXEMPLAR_ID: exemplar,
            OPERATION_ID: randStr(20),
            'id[0]': `TASK_${String(taskId)}`,
            'id[1]': '0',
            'ANALYTICS_LABEL[context]': 'add_comment_field',
        });
        // Вложения: serverFileId вида n<diskObjectId> в скрытом поле UF_FORUM_MESSAGE_DOC.
        fileIds.forEach((fid, i) => body.set(`UF_FORUM_MESSAGE_DOC[${i}]`, fid));

        const res = await this.raw(
            '/bitrix/services/main/ajax.php?mode=class&c=bitrix:forum.comments&action=processComment',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Bitrix-Csrf-Token': sessid || '',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: this.baseUrl + refererPath,
                },
                body: body.toString(),
            },
        );
        const data = await res.json().catch(() => null);

        if (data?.status !== 'success') {
            const msg = data?.errorMessage || (data?.errors || []).map((e: Payload) => e.message).join('; ');
            if (retry && /sign|sessid|csrf|param/i.test(msg || '')) {
                await this.getSessid(true);
                return this.sendComment(taskId, text, fileIds, false);
            }
            throw new Error(msg || 'Не удалось добавить комментарий');
        }

        const m = (data.message || '').match(/com(\d+)/);
        return { ok: true, commentId: m ? Number(m[1]) : null, message: data.okMessage || 'Комментарий добавлен.' };
    }

    /**
     * Скачивает медиа (картинки) из описания задачи во внешний кеш и возвращает
     * список найденных ссылок с результатом скачивания. Внешние ссылки
     * (Яндекс.Диск, прямые URL картинок) резолвятся и качаются; приватные
     * Telegram-ссылки и видео — помечаются как недоступные для авто-загрузки.
     */
    async getTaskMedia(taskId: unknown): Promise<unknown> {
        const d = await this.taskDetails(taskId);
        const media = await this.collectMedia(taskId, d.description);
        return { taskId, title: d.title, url: d.url, media };
    }

    /**
     * Скачивает медиа из переданного описания (без повторного запроса деталей).
     * Используется b24_task, чтобы показывать картинки и не дёргать taskDetails дважды.
     */
    async collectMedia(taskId: unknown, description: unknown): Promise<unknown> {
        const destDir = join(this.mediaDir || '/tmp/b24-media', `task-${taskId}`);
        return fetchTaskMedia(description || '', destDir);
    }

    /**
     * Авторизованный POST с телом form-urlencoded и автоперелогином (как apiGet, но POST).
     */
    async apiGet2(path: string, body: BodyInit, retry = true): Promise<Payload> {
        await this.ensureAuth();
        const res = await this.raw(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            if (retry) {
                await this.doLogin();
                return this.apiGet2(path, body, false);
            }
            throw new Error(`Ожидался JSON, получен ${ct || 'unknown'} (HTTP ${res.status}).`);
        }

        return asPayload(await res.json());
    }

    /**
     * Управление таймером задачи: action = 'start' | 'pause' | 'stop'.
     * start — «взять в работу» (перевод в «Выполняется» + учёт времени).
     * Требует sessid; при невалидном sessid перечитывает его и повторяет один раз.
     */
    async timer(action: unknown, taskId: unknown, retry = true): Promise<unknown> {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const body = `action=${encodeURIComponent(String(action))}`
            + `&taskId=${encodeURIComponent(String(taskId))}`
            + `&sessid=${encodeURIComponent(sessid || '')}`;
        const res = await this.raw('/local/ajax/task_timer.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            // Скорее всего протухла сессия — перелогин + свежий sessid, один повтор.
            if (retry) {
                await this.doLogin();
                return this.timer(action, taskId, false);
            }
            throw new Error(`task_timer.php вернул не JSON (HTTP ${res.status}).`);
        }
        const data = await res.json();
        if (!data?.success) {
            // Возможна ошибка CSRF — обновим sessid и повторим один раз.
            if (retry) {
                await this.getSessid(true);
                return this.timer(action, taskId, false);
            }
            throw new Error(data?.error || 'Ошибка таймера');
        }
        return data.data ?? {};
    }

    /**
     * Завершить задачу (перевод в статус «Завершена», COMPLETED=5).
     * Идёт через штатный контроллер tasks.task.complete (session-AJAX).
     * При протухшей сессии/CSRF — перелогин и один повтор.
     *
     * ВАЖНО: перед завершением явно стопорим таймер. Портальный авто-стоп при
     * завершении ненадёжен — накопленное время может зависнуть в накопителе
     * задачи и не попасть в дневной журнал отработанного. Явный stop через
     * task_timer.php гарантированно фиксирует сеанс. Если таймер не запущен —
     * stop тихо игнорируется, на завершение это не влияет.
     */
    async completeTask(taskId: unknown, retry = true): Promise<unknown> {
        await this.ensureAuth();

        // Сначала фиксируем время (если таймер шёл), потом завершаем.
        let timerSaved = null;
        try {
            timerSaved = await this.timer('stop', taskId);
        } catch {
            // Таймер мог быть не запущен — это не ошибка завершения.
        }

        const sessid = await this.getSessid();
        const uid = (await this.discoverUserId()) ?? 0;
        const refererPath = `/company/personal/user/${uid}/tasks/task/view/${taskId}/`;
        const body = new URLSearchParams({
            taskId: String(taskId),
            sessid: sessid || '',
        });
        const res = await this.raw(
            '/bitrix/services/main/ajax.php?action=tasks.task.complete',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Bitrix-Csrf-Token': sessid || '',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: this.baseUrl + refererPath,
                },
                body: body.toString(),
            },
        );
        const data = await res.json().catch(() => null);
        if (data?.status !== 'success') {
            const msg = data?.errorMessage
                || (data?.errors || []).map((e: Payload) => e.message || e.code).join('; ');
            // Похоже на протухшую сессию/CSRF — перелогин + свежий sessid, один повтор.
            if (retry && /sign|sessid|csrf|auth|param|denied|access/i.test(msg || '')) {
                await this.doLogin();
                await this.getSessid(true);
                return this.completeTask(taskId, false);
            }
            throw new Error(msg || 'Не удалось завершить задачу');
        }
        // Прокидываем результат стопа таймера, чтобы вызывающий показал
        // зафиксированное время.
        return { ...(data.data ?? { ok: true }), timerSaved };
    }

    /**
     * Возобновить задачу (renew) — вернуть из «Сдана» (status 4) или «Завершена»
     * (status 5) обратно в работу. На сданной/завершённой задаче таймер НЕ
     * запускается, пока её не возобновили (в UI это пункт «Возобновить» в меню
     * «Ещё»): без renew task_timer.php?action=start возвращает success со старым
     * started_at, но реально таймер не идёт. Идёт через штатный tasks.task.renew
     * (session-AJAX), как complete. При протухшей сессии/CSRF — перелогин и один повтор.
     */
    async renewTask(taskId: unknown, retry = true): Promise<unknown> {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const uid = (await this.discoverUserId()) ?? 0;
        const refererPath = `/company/personal/user/${uid}/tasks/task/view/${taskId}/`;
        const body = new URLSearchParams({
            taskId: String(taskId),
            sessid: sessid || '',
        });
        const res = await this.raw(
            '/bitrix/services/main/ajax.php?action=tasks.task.renew',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Bitrix-Csrf-Token': sessid || '',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: this.baseUrl + refererPath,
                },
                body: body.toString(),
            },
        );
        const data = await res.json().catch(() => null);
        if (data?.status !== 'success') {
            const msg = data?.errorMessage
                || (data?.errors || []).map((e: Payload) => e.message || e.code).join('; ');
            // Похоже на протухшую сессию/CSRF — перелогин + свежий sessid, один повтор.
            if (retry && /sign|sessid|csrf|auth|param|denied|access/i.test(msg || '')) {
                await this.doLogin();
                await this.getSessid(true);
                return this.renewTask(taskId, false);
            }
            throw new Error(msg || 'Не удалось возобновить задачу');
        }
        return data.data ?? { ok: true };
    }
}
