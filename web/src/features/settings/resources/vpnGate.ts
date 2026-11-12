import { decodeVpnGateView, type VpnGateView } from '../../../../../shared/runtime/vpnGateContracts.ts';
import type { ApiClient } from '../../../shared/apiClient.ts';
import type { ResourceAdapter } from '../contracts.ts';

/**
 * Ворота входят в общий черновик, но API принимает все три параметра вместе.
 * Подтверждённый ответ обновляет значения полей и признак необходимости перезапуска.
 */
export function createVpnGateResource(client: Pick<ApiClient, 'get' | 'put'>) {
  let view: VpnGateView | null = null;
  const adapter: ResourceAdapter = {
    id: 'vpnGate',
    chain: 'vpnGate',
    order: 7100,
    body: 'full-record',
    supportsUnset: false,
    async read(signal) {
      view = decodeVpnGateView(await client.get('/api/system/vpn-gate', { signal }));

      return {
        requireVpn: view.requireVpn,
        iface: view.iface,
        probe: view.probe,
      };
    },
    validate: () => [],
    /**
     * Неизменённые поля берутся из baseline, чтобы полный PUT их не сбрасывал.
     * Ошибка или повреждённый ACK оставляет намерения для повторного применения.
     */
    async write(intents, baseline, signal) {
      const values = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          values[key] = intent.value;
        }
      }

      view = decodeVpnGateView(await client.put('/api/system/vpn-gate', {
        requireVpn: values.requireVpn,
        iface: String(values.iface).trim(),
        probe: String(values.probe).trim(),
      }, { signal }));

      const confirmed = {
        requireVpn: view.requireVpn,
        iface: view.iface,
        probe: view.probe,
      };

      return {
        status: 'success',
        fields: [...intents.keys()].map((key) => ({
          key,
          status: 'success',
          serverValue: confirmed[key as keyof typeof confirmed],
        })),
      };
    },
  };

  return { adapter, view: () => view };
}
