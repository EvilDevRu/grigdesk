// Подключает прежний журнал только к фикстурам подписанной установки v2.
export const legacyControlStub = {
  'shared/node/installedControl.ts': `
    import { InstalledUpdateService } from '../../tests/fixtures/release-v2/installedUpdateService.ts';
    import { createUpdateHandoff } from '../../tests/fixtures/release-v2/installedUpdateWorker.ts';
    const services = new Map();
    export async function usesInstalledControl() { return true; }
    export async function installedControl(root, action, input) {
      if (!services.has(root)) {
        services.set(root, new InstalledUpdateService(root));
      }
      const service = services.get(root);
      switch (action) {
        case 'status': return service.status();
        case 'check': return service.checkUpdates();
        case 'create-job': return service.manager().createJob(input);
        case 'set-channel': return service.setChannel(input.channel);
        case 'handoff': return createUpdateHandoff(root, input.jobId, input);
        default: throw new Error('Неожиданное действие фикстуры: ' + action);
      }
    }
  `,
};
