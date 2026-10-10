import type { MobileApp } from '../mobileServer.ts';
import type { FacadeDeps } from './common.ts';
import { registerAppRoutes } from './app.ts';
import { registerChatRoutes, registerMessageRoutes } from './chats.ts';
import { registerEventRoutes } from './events.ts';
import { registerMediaRoutes } from './media.ts';
import { registerWaitingRoutes } from './waiting.ts';
import { registerTaskRoutes } from './tasks.ts';
import { registerB24Routes } from './b24.ts';
import { registerChatControlRoutes } from './chatControls.ts';
import { registerAttentionRoutes } from './attention.ts';

/**
 * Единая точка сборки v1 получает доверенные порты основного владельца состояния.
 * Все маршруты остаются под TLS identity guard и durable журналом мобильного входа.
 */
export function registerMobileFacade(app: MobileApp, deps: FacadeDeps) {
  registerChatRoutes(app, deps);
  registerChatControlRoutes(app, deps);
  registerAttentionRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerWaitingRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerB24Routes(app, deps);
  registerMediaRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerAppRoutes(app, deps);
}
