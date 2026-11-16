import { setTimeout as pause } from 'node:timers/promises';
import { factorySnapshotHash } from '../../shared/node/factorySnapshotHash.ts';
import { B24Error } from './errors.ts';
import { jsonRequest } from './pipelineApp.ts';
import type { PipelineContext, PipelineResult, PipelineSpec } from './pipelineApp.ts';
import { decodeMobile } from './pipelineControl.ts';

type Row = Record<string, unknown>;

/**
 * Создаёт реальный абсолютный срок для одной группы HTTP-чтений.
 * Тестовые часы подменяют также этот scheduler, не соревнуясь с таймером ОС.
 */
function armDeadline(milliseconds: number): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new B24Error(124, 'Истёк срок ожидания.'));
    }, milliseconds);

    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
    };
}
/**
 * Невалидный DTO сервера не выдаётся за отсутствие работы.
 * Отказы входных декодеров переводятся в транспортный код 22.
 */
function record(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new B24Error(22, 'GrigDesk вернул неверный снимок ожидания.');
    }

    return value as Row;
}
/**
 * Читает лёгкую authority, а detail запрашивает только при отсутствии процесса.
 * Повторная authority после detail отбрасывает смешанные снимки.
 */
async function observation(context: PipelineContext & {
    task: string;
}, signal: AbortSignal): Promise<Row> {
    const path = '/api/tasks/' + context.task;
    const first = record(await jsonRequest(context, 'GET', path + '/mobile-state', undefined, signal));

    if (typeof first.running !== 'boolean') {
        throw new B24Error(22, 'В снимке отсутствует running.');
    }
    if (first.identity !== null) {
        try {
            decodeMobile(first.identity);
        }
        catch {
            throw new B24Error(22, 'В снимке отсутствует exact identity.');
        }
    }

    if (first.identity === null) {
        const before = record(await jsonRequest(context, 'GET', path + '/prelude-state', undefined, signal));
        const detail = record(await jsonRequest(context, 'GET', path, undefined, signal));
        const after = record(await jsonRequest(context, 'GET', path + '/prelude-state', undefined, signal));
        const prelude = after.identity === null ? null : record(after.identity);

        if (typeof after.running !== 'boolean'
          || typeof after.attempt !== 'string' || !/^a_[a-f0-9]{32}$/u.test(after.attempt)
          || typeof after.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(after.profile)
          || (after.terminal !== null && (typeof after.terminal !== 'string'
            || !/^[a-z][a-z0-9_-]{0,63}$/u.test(after.terminal)))) {
            throw new B24Error(22, 'Некорректная trusted authority подготовительной фазы.');
        }

        return {
            identity: null,
            prelude,
            detail,
            attempt: after.attempt,
            profile: after.profile,
            terminal: after.terminal,
            running: after.running,
            stable: (prelude !== null || after.terminal !== null)
                && factorySnapshotHash(before) === factorySnapshotHash(after)
                && detail.attempt === after.attempt && detail.profile === after.profile,
        };
    }

    if ((first.running && first.identity !== null) || record(first.identity ?? {}).terminal) {
        return {
            ...first, stable: true
        };
    }

    const detail = record(await jsonRequest(context, 'GET', path, undefined, signal));
    const second = record(await jsonRequest(context, 'GET', path + '/mobile-state', undefined, signal));

    return {
        ...second,
        detail,
        stable: factorySnapshotHash(first) === factorySnapshotHash(second),
    };
}
/**
 * Ждёт наблюдаемое состояние одной attempt, ограничивая и HTTP, и паузы общим сроком.
 * Переход на другую attempt не становится молчаливым продолжением наблюдения.
 */
async function wait(values: Record<string, string>, base: PipelineContext): Promise<PipelineResult> {
    const timeoutMs = Number(values.timeoutMs);
    const intervalMs = Number(values.intervalMs);

    if (timeoutMs > 86400000 || intervalMs > 60000) {
        throw new B24Error(2, 'Слишком большой срок или интервал wait.');
    }

    const context = {
        ...base, task: values.task!
    };
    const now = base.io.now ?? (() => performance.now());
    const sleep = base.io.sleep ?? ((ms: number, signal?: AbortSignal) => {
        return pause(ms, undefined, {
            signal
        });
    });
    const deadline = now() + timeoutMs;

    while (now() < deadline) {
        const armed = (base.io.armDeadline ?? armDeadline)(Math.max(1, deadline - now()));
        let sample: Row;

        try {
            sample = await observation(context, armed.signal);
        }
        catch (error) {
            if (error instanceof B24Error && error.code === 124) {
                return {
                    output: {
                        outcome: 'timeout',
                        task: values.task,
                        attempt: values.attempt
                    }, code: 124
                };
            }

            throw error;
        }
        finally {
            armed.dispose();
        }

        const identity = sample.identity === null ? null : record(sample.identity);
        const detail = sample.detail === undefined ? null : record(sample.detail);

        if (detail?.readOnly === true) {
            throw new B24Error(22, 'Историческая попытка недоступна для exact ожидания.');
        }

        const observedAttempt = identity?.attempt ?? sample.attempt
            ?? (sample.prelude ? record(sample.prelude).attempt : detail?.attempt);

        if (observedAttempt !== values.attempt) {
            throw new B24Error(22, 'Попытка изменилась или её identity недоступна.');
        }

        const terminal = identity?.terminal ?? sample.terminal ?? null;

        if (terminal !== null && (identity !== null || sample.stable)) {
            return {
                output: {
                    outcome: 'terminal',
                    task: values.task,
                    attempt: values.attempt,
                    terminal,
                    identity,
                },
            };
        }
        if (sample.stable && !sample.running && detail && detail.daemonAlive === false
            && detail.attempt === values.attempt && detail.readOnly === false
            && (!identity || detail.profile === identity.profile)) {
            const bootstrap = detail.bootstrapStop ? record(detail.bootstrapStop) : null;

            if (bootstrap?.state === 'waiting' || identity?.state === 'paused'
                || identity?.stop || detail.stall) {
                return {
                    output: {
                        outcome: 'human',
                        task: values.task,
                        attempt: values.attempt,
                        identity,
                        reason: bootstrap ?? detail.stall ?? identity?.stop ?? identity?.state
                    }
                };
            }

            const registry = record(detail.registry);

            if (registry.STOPPED_SIGNAL === '1') {
                return {
                    output: {
                        outcome: 'stopped',
                        task: values.task,
                        attempt: values.attempt,
                        identity
                    }
                };
            }

            // Создание без старта: попытка готова и ждёт ручного запуска, демон
            // штатно завершён. Это решение человека, а не обрыв — wait не должен
            // доводить его до timeout.
            if (registry.HELD_START === '1') {
                return {
                    output: {
                        outcome: 'stopped',
                        task: values.task,
                        attempt: values.attempt,
                        identity
                    }
                };
            }
        }

        const remaining = deadline - now();

        if (remaining > 0) {
            try {
                await sleep(Math.min(intervalMs, remaining), base.io.signal);
            }
            catch (error) {
                if (base.io.signal?.aborted) {
                    throw base.io.signal.reason;
                }

                throw error;
            }
        }
    }

    return {
        output: {
            outcome: 'timeout',
            task: values.task,
            attempt: values.attempt
        }, code: 124
    };
}

export const WAIT_COMMANDS: Record<string, PipelineSpec> = {
    wait: {
        params: ['task', 'attempt', 'timeoutMs', 'intervalMs'],
        defaults: {
            timeoutMs: '600000', intervalMs: '2000'
        },
        method: 'GET',
        path: () => '',
        run: wait,
    },
};
