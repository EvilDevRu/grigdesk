import type { FastifyInstance } from 'fastify';

import type { ClientListener } from './listener.ts';

export const phoneAccessOwners = new WeakMap<FastifyInstance, { start(): Promise<ClientListener> }>();
