// Что кокпит дописывает к экземпляру Fastify и к запросу.
//
// Раньше каждый модуль объявлял нужную ему часть у себя: десять копий одного и того же
// с расходящимися сигнатурами — где-то `sse` был обязательным, где-то нет. Расширение
// собрано здесь, поэтому «кто и что добавил» видно в одном месте, а модуль не может
// объявить чужое украшение по-своему.
//
// Файл участвует в проекте целиком, поэтому импортировать его ради типов не нужно:
// augmentation действует на всю программу.

import 'fastify';

import type { ShutdownCoordinator } from './shutdown.ts';

// Чем именно подтверждён запрос. Различать обязательно: внутренний токен процесса и
// сессия человека дают разные права, а CLI-токен не должен открывать чужие ручки.
export type AuthKind = 'session' | 'internal' | 'cli' | null;

// Рассылка событий вкладкам и внутренним слушателям. Один поток на вкладку —
// второй `EventSource` в браузере создавать нельзя.
export interface SseBus {
  broadcast(name: string, payload?: unknown): void;
  subscribe(listener: (name: string, payload?: unknown) => void): () => void;
  // Сколько окон держат поток: фоновая работа ради пустого зала не нужна.
  clientCount(): number;
}

declare module 'fastify' {
  interface FastifyInstance {
    // Включён ли плагин раздела. Выключенный отвечает своим кодом, а не 404.
    pluginEnabled(id: string): boolean;
    // Настройки плагина: их форму знает только сам раздел.
    pluginSettings?(id: string): unknown;
    sse?: Partial<SseBus>;
    // Пути артефактов разбора видео: наружу уходит имя, а не путь на диске.
    mediaClipPath?(name: string): string | null;
    mediaFramePath?(name: string): string | null;
    // Брокеры надзорных инструментов агента.
    dbBroker?: unknown;
    sshBroker?: unknown;
    knowledgeBroker?: unknown;
    // Реестр исполнителей и разбор арбитра — их подключает сборка приложения.
    executorFor?(id: string): Promise<unknown>;
    providerRegistry?(): Promise<unknown>;
    factoryArbitrate?(...args: unknown[]): Promise<unknown>;
    telegramDiscussion?(text: unknown, options?: Record<string, unknown>): Promise<unknown>;
    // Остановка сервера: модули регистрируют слив, точка входа и кнопка перезапуска её начинают.
    shutdown?: ShutdownCoordinator;
  }

  interface FastifyRequest {
    authKind?: AuthKind;
  }
}
