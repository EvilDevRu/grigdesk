// Клиент к порталу b24.discript.ru (Битрикс24).
//
// Авторизация — как в браузере: POST формы логина /salary/?login=yes отдаёт
// сессионные куки (BITRIX_SM_*, PHPSESSID), дальше все запросы идут с этими
// куками. USER_REMEMBER=Y делает сессию долгоживущей. REST-токен/вебхук НЕ
// используются — прав на их создание в портале нет.

import { join } from 'node:path';
import { CookieJar } from './cookie-jar.js';
import { describeStatus } from './status.js';
import { fetchTaskMedia } from './media.js';
import {
    detectMime,
    readFileSource,
    DISK_UPLOADER_CONTROLLER,
    UPLOAD_CHUNK_SIZE,
} from './upload.js';

// UA как у обычного браузера — чтобы портал не отбивал запрос как бота.
const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Случайная строка для клиентских id (EXEMPLAR_ID/OPERATION_ID) в форме комментария.
function randStr(n) {
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
function htmlToText(s) {
    return (s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Возвращает внутренний HTML <div> с заданным id, корректно учитывая вложенные
 * <div> (подсчёт глубины). Нужен для извлечения текста комментария, который сам
 * содержит вложенные div'ы — обрезка по «первому </div>» сломала бы его.
 */
function extractDivById(html, id) {
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
    let m;
    while ((m = re.exec(html))) {
        depth += m[0][1] === '/' ? -1 : 1;
        if (depth === 0) {
            return html.slice(startInner, m.index);
        }
    }
    return null;
}

export class B24Client {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl   например https://b24.discript.ru
     * @param {string} opts.login     логин (email)
     * @param {string} opts.password  пароль
     * @param {string|null} opts.cookiePath путь для хранения кук между запусками
     * @param {number|null} opts.userId опциональный жёстко заданный user_id
     */
    constructor({ baseUrl, login, password, cookiePath = null, userId = null, mediaDir = null }) {
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
    url(path) {
        return path.startsWith('http') ? path : this.baseUrl + path;
    }

    /**
     * Низкоуровневый fetch с куками. Поглощает Set-Cookie из ответа (ротация сессии).
     * redirect:'manual' — чтобы не потерять куки на промежуточных 30x.
     */
    async raw(path, { method = 'GET', headers = {}, body = null } = {}) {
        // Ретрай на транзиентные сетевые сбои (ECONNRESET / «socket disconnected
        // before TLS» — fetch при этом бросает исключение, а не возвращает ответ).
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt += 1) {
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
                });
                this.jar.absorb(res.headers.getSetCookie?.() ?? []);
                return res;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }

    /**
     * Выполняет вход. Бросает исключение, если после логина проба не подтверждает сессию.
     */
    async doLogin() {
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
    async isAuthed() {
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
    async ensureAuth() {
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
    async apiGet(path, retry = true) {
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
    async discoverUserId() {
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
    async status() {
        await this.ensureAuth();
        const notif = await this.apiGet('/local/ajax/notifications.php?action=count');
        const userId = await this.discoverUserId();
        return {
            authorized: true,
            login: this.login,
            userId,
            notifications: notif?.count ?? null,
        };
    }

    // ==================== ЗАДАЧИ ====================

    /**
     * Достаёт CSRF-токен (bitrix_sessid) со страницы дашборда. Нужен для пишущих
     * действий (таймер). Кешируется; force=true — перечитать (после перелогина/протухания).
     */
    async getSessid(force = false) {
        if (this.sessid && !force) {
            return this.sessid;
        }
        await this.ensureAuth();
        const html = await (await this.raw('/salary/?project_id=0')).text();
        const m = html.match(/bitrix_sessid"?\s*:\s*"([a-f0-9]+)"/);
        this.sessid = m ? m[1] : null;
        return this.sessid;
    }

    /**
     * Нормализует «сырую» задачу из getTodayData в компактный вид и навешивает
     * семантику статуса (что значит / чьё действие) относительно myId.
     */
    mapTask(t, myId) {
        const mapped = {
            id: t.id,
            title: t.title,
            group: t.group_name || '',
            groupId: t.group_id ?? null,
            // custom_priority: 1..N — ручной порядок; 0/пусто — ручного приоритета нет.
            cp: t.custom_priority > 0 ? t.custom_priority : null,
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
    static comparePriority(a, b) {
        if (a.actionable !== b.actionable) {
            return a.actionable ? -1 : 1;
        }
        const acp = a.cp ?? Infinity;
        const bcp = b.cp ?? Infinity;
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
            return b.priority - a.priority;
        }
        const ad = a.deadlineRaw || '9999';
        const bd = b.deadlineRaw || '9999';
        if (ad !== bd) {
            return ad < bd ? -1 : 1;
        }
        return a.id - b.id;
    }

    /**
     * Список задач, отсортированный по приоритету.
     * @param {object} opts
     * @param {boolean} opts.all true — все мои активные задачи (~43), false — приоритизированный набор (~9)
     */
    async listTasks({ all = true } = {}) {
        const uid = (await this.discoverUserId()) ?? 0;
        const flag = all ? 1 : 0;
        const data = await this.apiGet(
            `/local/ajax/dashboard.php?action=getTodayData&user_id=${uid}&project_id=0&show_all_tasks=${flag}`,
        );
        const tasks = (data?.data?.currentTasks ?? []).map((t) => this.mapTask(t, uid));
        tasks.sort(B24Client.comparePriority);
        return tasks;
    }

    /**
     * Статистика отработанного времени за текущий месяц. Данные зашиты в HTML
     * дашборда (chartDataByPeriod), отдельного JSON-эндпоинта нет:
     * сумма day.hours = отработано за месяц; «Норма: Nч» — план.
     */
    async getMonthStats() {
        await this.ensureAuth();
        const html = await (await this.raw('/salary/?project_id=0')).text();
        let hours = 0;
        // Первое вхождение "day":{...} — реальные данные (далее идут пустые перезаписи).
        const dayMatch = html.match(/"day":\s*\{([^{}]*)\}/);
        if (dayMatch) {
            const hm = dayMatch[1].match(/"hours":\s*\[([-\d.,\s]*)\]/);
            if (hm) {
                hours = hm[1]
                    .split(',')
                    .map(Number)
                    .filter((x) => !Number.isNaN(x))
                    .reduce((a, b) => a + b, 0);
            }
        }
        const normM = html.match(/Норма:\s*(\d+)\s*ч/);
        return { hours, norm: normM ? Number(normM[1]) : null };
    }

    /**
     * Список задач + сводка по отработанному времени (сегодня и за месяц) за один проход:
     * getTodayData отдаёт и задачи, и todayData (сегодня), а страница — месяц.
     * @param {object} opts
     * @param {boolean} opts.all все мои активные задачи (true) или приоритетный набор (false)
     */
    async getDashboard({ all = true } = {}) {
        const uid = (await this.discoverUserId()) ?? 0;
        const flag = all ? 1 : 0;
        const data = await this.apiGet(
            `/local/ajax/dashboard.php?action=getTodayData&user_id=${uid}&project_id=0&show_all_tasks=${flag}`,
        );
        const tasks = (data?.data?.currentTasks ?? []).map((t) => this.mapTask(t, uid));
        tasks.sort(B24Client.comparePriority);
        const td = data?.data?.todayData ?? {};
        const month = await this.getMonthStats();
        return {
            tasks,
            today: { hours: td.hours ?? 0, tasks: td.tasks_count ?? 0 },
            month,
        };
    }

    /**
     * Полные детали задачи (getTaskDetails).
     */
    async taskDetails(taskId) {
        const data = await this.apiGet2('/local/ajax/dashboard.php', `action=getTaskDetails&taskId=${encodeURIComponent(taskId)}`);
        if (!data?.success) {
            throw new Error(data?.error || 'Не удалось получить детали задачи');
        }
        return data.data;
    }

    /**
     * Парсит вложения ЗАДАЧИ (поле UF_TASK_WEBDAV_FILES) из HTML страницы задачи.
     * getTaskDetails вложения не отдаёт — берём их со страницы. Файлы задачи лежат
     * в контейнере `<div id="task-detail-files">`; ограничиваем разбор этим блоком
     * (до начала компонента комментариев), чтобы не захватить вложения комментариев.
     * @param {string} html
     * @returns {Array<{attachedId:number,name:string,objectId:number|null,downloadPath:string,isImage:boolean}>}
     */
    static parseTaskAttachments(html) {
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
    static parseDiskAttachments(block) {
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
    static parseTaskComments(html, taskId) {
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
            const seg = block.slice(covers[i].idx, i + 1 < covers.length ? covers[i + 1].idx : block.length);
            const mid = covers[i].mid;
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
                unread: covers[i].read === 'new',
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
    async taskPageData(taskId) {
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
    async fetchAttachmentBytes(downloadPath) {
        await this.ensureAuth();
        const res = await this.raw(downloadPath);
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
        return { buffer, contentType };
    }

    /**
     * Определяет «проект по умолчанию» — самую частую группу среди моих задач
     * (на этом портале это обычно arsenkin.ru). Возвращает { groupId, groupName } или null.
     */
    async resolveDefaultGroup() {
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
     * Ростер пользователей портала (для выбора исполнителя). getAvailableUsers
     * отдаёт весь список (id, name, position, …); фильтрация по имени — на нашей стороне,
     * сервер параметр поиска игнорирует. Результат кешируется на время жизни процесса.
     * @returns {Promise<Array<{id:number,name:string,position:string}>>}
     */
    async listUsers(force = false) {
        if (this._users && !force) {
            return this._users;
        }
        const data = await this.apiGet2('/local/ajax/dashboard.php', 'action=getAvailableUsers');
        const users = Array.isArray(data?.data) ? data.data : [];
        this._users = users.map((u) => ({
            id: Number(u.id),
            name: u.name || '',
            position: u.position || '',
        }));
        return this._users;
    }

    /**
     * Поиск пользователей по имени: совпадают ВСЕ токены запроса (в любом порядке,
     * регистронезависимо), поэтому «Бергман Дмитрий» и «Дмитрий Бергман» дадут одно.
     * Пустой запрос — весь ростер.
     * @returns {Promise<Array<{id:number,name:string,position:string}>>}
     */
    async findUsers(query) {
        const users = await this.listUsers();
        const tokens = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
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
     * @param {string|{path?:string,buffer?:Buffer,base64?:string,name?:string}} source
     *        путь к файлу ИЛИ объект-источник (готовый Buffer / base64 + имя)
     * @returns {Promise<{id:string,name:string,objectId:number|null,size:number,isImage:boolean,contentType:string}>}
     */
    async uploadDiskFile(source, retry = true) {
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
        let token = '';
        let file = null;

        // Отправка одного чанка. single=true — файл влез целиком, шлём без Content-Range
        // (ровно как браузер при offset=0 и size==total).
        const sendChunk = async (offset, single) => {
            const end = Math.min(offset + UPLOAD_CHUNK_SIZE, total);
            const chunk = buffer.subarray(offset, end);
            const headers = {
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
                token: token || '',
                sessid: sessid || '',
            });
            const res = await this.raw('/bitrix/services/main/ajax.php?' + qs.toString(), {
                method: 'POST',
                headers,
                body: chunk,
            });
            const data = await res.json().catch(() => null);
            if (data?.status !== 'success') {
                const msg = data?.errorMessage || (data?.errors || []).map((e) => e.message).join('; ');
                const err = new Error(msg || 'Не удалось загрузить файл на диск');
                err.csrf = /csrf|sessid|sign/i.test(msg || '');
                throw err;
            }
            if (data.data?.token) {
                token = data.data.token;
            }
            if (data.data?.file) {
                file = data.data.file;
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
            if (retry && e.csrf) {
                await this.getSessid(true);
                return this.uploadDiskFile(source, false);
            }
            throw e;
        }

        if (!file?.serverFileId) {
            throw new Error(`Загрузка «${name}» не вернула serverFileId`);
        }
        return {
            id: file.serverFileId,
            name: file.name || name,
            objectId: file.customData?.objectId ?? null,
            size: file.size ?? total,
            isImage: !!file.isImage,
            contentType: mime,
        };
    }

    /**
     * Загружает несколько файлов по очереди (см. uploadDiskFile).
     * @param {Array<string|object>} sources
     * @returns {Promise<Array<{id:string,name:string,objectId:number|null,size:number,isImage:boolean,contentType:string}>>}
     */
    async uploadDiskFiles(sources) {
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
     * @param {number|null} opts.groupId  группа/проект (если null — определяется автоматически)
     * @param {number|null} opts.responsibleId ответственный (если null — я)
     * @param {number|null} opts.createdById постановщик/автор задачи (если null — я)
     * @param {Array<string|object>} opts.images пути к файлам/изображениям для прикрепления
     * @returns {Promise<{id:number, group:{id:number,name:string}|null, responsibleId:number, files:Array}>}
     */
    async createTask({ title, description = '', groupId = null, responsibleId = null, createdById = null, images = [] }) {
        if (!title || !title.trim()) {
            throw new Error('Пустой заголовок задачи');
        }
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
            fileIds: uploaded.map((u) => u.id),
        });
        return { ...result, files: uploaded };
    }

    /**
     * Отправляет tasks.task.add с уже готовыми serverFileId вложений.
     * Выделено из createTask, чтобы CSRF-ретрай не перезагружал файлы заново.
     */
    async sendTaskAdd({ title, description, groupId, responsibleId, createdById = null, fileIds }, retry = true) {
        const sessid = await this.getSessid();
        const body = new URLSearchParams();
        body.set('fields[TITLE]', title);
        if (description) {
            body.set('fields[DESCRIPTION]', description);
        }
        body.set('fields[RESPONSIBLE_ID]', String(responsibleId));
        // Постановщик/автор. Если не задан — портал ставит создателя сессии (меня).
        if (createdById) {
            body.set('fields[CREATED_BY]', String(createdById));
        }
        if (groupId) {
            body.set('fields[GROUP_ID]', String(groupId));
        }
        fileIds.forEach((fid, i) => body.set(`fields[UF_TASK_WEBDAV_FILES][${i}]`, fid));
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
            const msg = (data?.errors || []).map((e) => e.message).join('; ');
            // Протух CSRF — обновим sessid и повторим один раз.
            if (retry && /csrf|sessid|sign/i.test(msg)) {
                await this.getSessid(true);
                return this.sendTaskAdd({ title, description, groupId, responsibleId, createdById, fileIds }, false);
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
        };
    }

    /**
     * Удаляет задачу через стандартный контроллер tasks.task.delete.
     * Действие необратимое (задача уходит в корзину/удаляется).
     */
    async deleteTask(taskId, retry = true) {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const res = await this.raw('/bitrix/services/main/ajax.php?action=tasks.task.delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Bitrix-Csrf-Token': sessid || '',
            },
            body: `taskId=${encodeURIComponent(taskId)}&sessid=${encodeURIComponent(sessid || '')}`,
        });
        const data = await res.json().catch(() => null);
        if (data?.status !== 'success') {
            const msg = (data?.errors || []).map((e) => e.message).join('; ');
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
    static extractCommentSignedParams(html) {
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
                out += html[j + 1];
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
     * @param {number} taskId
     * @param {string} text   текст комментария (обязателен, даже при вложениях)
     * @param {object} [opts]
     * @param {Array<string|object>} [opts.images] пути к файлам/изображениям для прикрепления
     */
    async addComment(taskId, text, { images = [] } = {}) {
        if (!text || !text.trim()) {
            throw new Error('Пустой комментарий');
        }
        // Грузим вложения один раз — вне CSRF-ретраев самой отправки комментария.
        const uploaded = images.length ? await this.uploadDiskFiles(images) : [];
        const r = await this.sendComment(taskId, text, uploaded.map((u) => u.id));
        return { ...r, files: uploaded };
    }

    /**
     * Отправляет processComment с уже готовыми serverFileId вложений.
     * Выделено из addComment, чтобы перелогин/CSRF-ретрай не перезагружал файлы.
     */
    async sendComment(taskId, text, fileIds = [], retry = true) {
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
            ENTITY_XML_ID: `TASK_${taskId}`,
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
            signedParameters: signed,
            EXEMPLAR_ID: exemplar,
            OPERATION_ID: randStr(20),
            'id[0]': `TASK_${taskId}`,
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
            const msg = data?.errorMessage || (data?.errors || []).map((e) => e.message).join('; ');
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
    async getTaskMedia(taskId) {
        const d = await this.taskDetails(taskId);
        const media = await this.collectMedia(taskId, d.description);
        return { taskId, title: d.title, url: d.url, media };
    }

    /**
     * Скачивает медиа из переданного описания (без повторного запроса деталей).
     * Используется b24_task, чтобы показывать картинки и не дёргать taskDetails дважды.
     */
    async collectMedia(taskId, description) {
        const destDir = join(this.mediaDir || '/tmp/b24-media', `task-${taskId}`);
        return fetchTaskMedia(description || '', destDir);
    }

    /**
     * Авторизованный POST с телом form-urlencoded и автоперелогином (как apiGet, но POST).
     */
    async apiGet2(path, body, retry = true) {
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
        return res.json();
    }

    /**
     * Управление таймером задачи: action = 'start' | 'pause' | 'stop'.
     * start — «взять в работу» (перевод в «Выполняется» + учёт времени).
     * Требует sessid; при невалидном sessid перечитывает его и повторяет один раз.
     */
    async timer(action, taskId, retry = true) {
        await this.ensureAuth();
        const sessid = await this.getSessid();
        const body = `action=${encodeURIComponent(action)}&taskId=${encodeURIComponent(taskId)}&sessid=${encodeURIComponent(sessid || '')}`;
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
    async completeTask(taskId, retry = true) {
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
                || (data?.errors || []).map((e) => e.message || e.code).join('; ');
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
    async renewTask(taskId, retry = true) {
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
                || (data?.errors || []).map((e) => e.message || e.code).join('; ');
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
