// Что GrigDesk дописывает к экземпляру Fastify и к запросу.
//
// Раньше каждый модуль объявлял нужную ему часть у себя: десять копий одного и того же
// с расходящимися сигнатурами — где-то `sse` был обязательным, где-то нет. Расширение
// собрано здесь, поэтому «кто и что добавил» видно в одном месте, а модуль не может
// объявить чужое украшение по-своему.
//
// Файл участвует в проекте целиком, поэтому импортировать его ради типов не нужно:
// augmentation действует на всю программу.

import 'fastify';

// Изолированные HTTP-фикстуры не импортируют сборку приложения, регистрирующую плагины.
// Их расширения нужны и в таком графе типов; runtime-регистрация остаётся в приложении.
import type {} from '@fastify/multipart';
import type {} from '@fastify/websocket';

import type { ProviderUsagePatch } from './providerUsage.ts';
import type { ShutdownCoordinator } from './shutdown.ts';
import type { ProjectsService } from '../modules/projects/service.ts';
import type { StudioRuntime } from '../modules/studio3d/runtime.ts';
import type { PluginDocsEntry } from './pluginDocs.ts';
import type { ConversationAck } from './arbiterConversationService.ts';

// Чем именно подтверждён запрос. Различать обязательно: внутренний токен процесса и
// сессия человека дают разные права, а CLI-токен не должен открывать чужие ручки.
export type AuthKind = 'session' | 'internal' | 'cli' | null;

export interface AuthPrincipal {
  kind: 'device';
  deviceId: string;
}

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
    // Оглавления документации включённых пользовательских плагинов — для хода агента.
    pluginDocs?(): Promise<PluginDocsEntry[]>;
    sse?: Partial<SseBus>;
    // Пути артефактов разбора видео: наружу уходит имя, а не путь на диске.
    mediaClipPath?(name: string): string | null;
    mediaFramePath?(name: string): string | null;
    // Брокеры надзорных инструментов агента.
    dbBroker?: unknown;
    sshBroker?: unknown;
    // Реестр исполнителей и разбор арбитра — их подключает сборка приложения.
    executorFor?(id: string): Promise<unknown>;
    providerRegistry?(): Promise<unknown>;
    // Перечитать лимиты исполнителей, если снимок устарел, и разослать их событием
    // `providers-usage`. Для фоновых потребителей, которым снимок нужен и без окон.
    refreshProvidersUsage?(): Promise<void>;
    // Обработчик живёт вместе с процессом и принимает только поколение своего аккаунта.
    providerUsageSink?(providerId: string): (patch: ProviderUsagePatch) => boolean;
    // Обслуживание внешнего CLI сохраняет паузу аккаунта и отвергает старые callbacks.
    invalidateProviderRuntime?(providerId: string, options?: { removed?: boolean }): Promise<boolean>;
    factoryArbitrate?(
      task: string,
      reply: { code: (status: number) => { send: (body: unknown) => unknown } },
      options?: { actor?: string },
    ): Promise<ConversationAck | null>;
    telegramDiscussion?(text: unknown, options?: Record<string, unknown>): Promise<unknown>;
    // Сервис раздела «Проекты»: им пользуется и сам раздел, и ручка /api/profiles.
    projects?: ProjectsService;
    studio3d?: StudioRuntime;
    // Остановка сервера: модули регистрируют слив, точка входа и кнопка перезапуска её начинают.
    shutdown?: ShutdownCoordinator;
  }

  interface FastifyRequest {
    authKind?: AuthKind;
    authPrincipal?: AuthPrincipal | null;
  }
}
