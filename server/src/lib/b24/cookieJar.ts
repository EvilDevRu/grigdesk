// Минимальный cookie jar: хранит куки как name -> value и сериализует их
// в заголовок Cookie. Имена кук не хардкодим — забираем всё, что отдаёт сервер,
// поэтому реализация не зависит от конкретных BITRIX_SM_* и переживёт смену схемы.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class CookieJar {
    readonly cookies: Map<string, string>;

    readonly persistPath: string | null;

    /** `persistPath` — файл для хранения кук между запусками; null — только в памяти. */
    constructor(persistPath: string | null = null) {
        this.cookies = new Map();
        this.persistPath = persistPath;
        if (persistPath && existsSync(persistPath)) {
            try {
                const raw = JSON.parse(readFileSync(persistPath, 'utf-8')) as Record<string, unknown>;

                for (const [k, v] of Object.entries(raw)) {
                    this.cookies.set(k, String(v));
                }
            } catch {
                // битый файл кук — просто игнорируем, перелогинимся
            }
        }
    }

    /**
     * Поглощает массив строк Set-Cookie (Node 22: response.headers.getSetCookie()).
     * Берём только пару name=value из начала каждой строки, атрибуты (Path, Expires,
     * HttpOnly и т.д.) отбрасываем — для отправки обратно они не нужны.
     * Значение "deleted" или пустое — удаляет куку.
     */
    absorb(setCookieList: readonly string[] | null | undefined): void {
        if (!setCookieList || setCookieList.length === 0) {
            return;
        }
        for (const line of setCookieList) {
            const firstPair = line.split(';', 1)[0] ?? '';
            const eq = firstPair.indexOf('=');
            if (eq === -1) {
                continue;
            }
            const name = firstPair.slice(0, eq).trim();
            const value = firstPair.slice(eq + 1).trim();
            if (!name) {
                continue;
            }
            if (value === '' || value === 'deleted') {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
    }

    /**
     * Сериализует все куки в значение заголовка Cookie.
     */
    header(): string {
        const parts: string[] = [];
        for (const [k, v] of this.cookies) {
            parts.push(`${k}=${v}`);
        }
        return parts.join('; ');
    }

    isEmpty(): boolean {
        return this.cookies.size === 0;
    }

    clear(): void {
        this.cookies.clear();
    }

    /**
     * Сохраняет куки на диск (если задан persistPath).
     */
    persist(): void {
        if (!this.persistPath) {
            return;
        }
        mkdirSync(dirname(this.persistPath), { recursive: true });
        const obj = Object.fromEntries(this.cookies);
        writeFileSync(this.persistPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
    }
}
