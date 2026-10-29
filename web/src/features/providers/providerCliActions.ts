import type { ProviderEntry } from '../../../../shared/chat/providersContracts.ts';

/**
 * Обе распознанные формы установки обслуживаются общим lifecycle через окно GrigDesk.
 * Неизвестная копия не получает действие, способное затронуть другую программу.
 */
export function providerCliActions(
  provider: Pick<ProviderEntry, 'installation' | 'installed' | 'canUpdate' | 'install'>,
) {
  const metadata = provider.installation;
  const inventory = metadata?.inventory;
  const selectedCopy = inventory?.installations.find((copy) =>
    copy.installationId === inventory.selectedId);
  const external = metadata?.lifecycleProtocol === 2;

  return {
    selectedCopy,
    canUpdate: !!provider.installed && !!(metadata?.canUpdate ?? provider.canUpdate)
      && (!external || selectedCopy?.source === 'npm' || selectedCopy?.source === 'native'),
  };
}
