import { probeGigaCode } from '../gigacode/discovery.ts';
import { gigaCodeAuth } from '../gigacode/auth.ts';
import type { GigaCodeConfig } from '../gigacode/contract.ts';
import { gigaCodeCatalog, gigaCodeCatalogCacheKey } from '../gigacode/catalog.ts';
import { runGigaCodeTurn } from '../gigacode/runtime.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { RETRY_CONTRACT } from '../chat/retryContract.ts';

// Fresh-процесс воспроизводит историю ядра; native resume и делегирование выключены.
// Файловую границу обеспечивает обязательный host-owned bubblewrap на каждый ход.
export default {
  id: 'gigacode',
  name: 'GigaCode',
  vendor: 'Сбер / GitVerse',
  type: 'universal',
  kind: 'cli',
  color: '#9761FF',
  order: 6,
  bin: (config: GigaCodeConfig) => config.gigacodeBin || 'gigacode',
  probe: probeGigaCode,
  auth: gigaCodeAuth,
  seedModels: () => [],
  efforts: () => [],
  effortHints: {},
  catalogLive: true,
  catalogAuthoritativeEmpty: true,
  retryContract: RETRY_CONTRACT.NEVER,
  catalog: gigaCodeCatalog,
  catalogCacheKey: gigaCodeCatalogCacheKey,
  compaction: { kind: 'summary' },
  workToolsTransport: 'mcp',
  workdir: { switch: 'reseed', roots: 'multi' },
  directSshPolicy: {
    enforcement: 'fail-closed',
    note: 'При запрете прямого SSH или БД native shell и HTTP fetch полностью выключены.',
  },
  settings: [directSshSetting({
    note: 'Запрет выключает native shell и web_fetch целиком; файловые инструменты и MCP доступны.',
  })],
  modes: async () => [
    { id: 'default', label: 'Подтверждать действия' },
    { id: 'auto', label: 'Авто' },
    { id: 'read-only', label: 'Только чтение' },
  ],
  run: runGigaCodeTurn,
};
