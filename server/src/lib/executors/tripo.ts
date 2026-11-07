import type { ExecutorAdapter } from './index.ts';
import { readTripoBalance, tripoAccess } from '../tripo/account.ts';
import type { TripoAccountDeps } from '../tripo/account.ts';
import { createTripoStudio } from '../tripo/studio.ts';

/**
 * Объявляет API-исполнителя без чатового transport и каталога LLM-моделей.
 * Окружение читается на каждом вызове; офлайн-тесты подменяют сеть и время.
 */
export function createTripoAdapter(deps: TripoAccountDeps = {}): ExecutorAdapter {
  const env = deps.env ?? process.env;

  return {
    id: 'tripo',
    name: 'Tripo',
    vendor: 'VAST',
    color: '#FFFFFF',
    order: 10,
    type: '3d',
    kind: 'api',
    studio3d: createTripoStudio({ env, fetchImpl: deps.fetchImpl }),
    bin: () => null,
    probe: () => ({ ok: true, version: null }),
    auth: () => {
      const access = tripoAccess(env);

      return {
        mode: 'env',
        available: Boolean(access.key),
        label: `${access.key ? 'Ключ задан' : 'Ключ не задан'} · ${access.label}`,
      };
    },
    credentials: [
      {
        env: 'TRIPO_API_KEY',
        kind: 'secret',
        label: 'API-ключ Tripo'
      },
      {
        env: 'TRIPO_REGION',
        kind: 'choice',
        label: 'Регион',
        options: [
          { value: 'ov', label: 'Международный' },
          { value: 'cn', label: 'Китай' },
        ],
      },
    ],
    usage: () => readTripoBalance({ ...deps, env }),
  };
}

export default createTripoAdapter();
