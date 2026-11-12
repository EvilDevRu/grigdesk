import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Общая среда внешних HTTP-фикстур создаёт только временные каталоги и проекты.
 * Архивный путь сохранён как вход старого runtime для доказательства RED удаления API.
 */
export async function trackerEnvironment(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tracker-environment-'));
  const config = {};

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const key of [
    'stateDir', 'analysisDir', 'ticketsDir', 'sandboxJournalDir', 'factoryControlDir',
    'artifactsDir', 'profilesDir', 'factoryHome',
  ]) {
    config[key] = path.join(root, key);
    await mkdir(config[key], { recursive: true });
  }

  config.grigdeskTasksPath = path.join(root, 'tasks.json');
  config.sandboxManualRange = { from: 990000, to: 999999 };
  config.factoryProfile = 'alpha';

  const projects = ['alpha', 'beta', 'gamma'].map((id) => ({
    id,
    title: `Проект ${id}`,
    archivedAt: null,
    revision: 1,
    profile: { present: true },
    routes: ['feature'],
  }));

  for (const project of projects) {
    await mkdir(path.join(config.profilesDir, project.id), { recursive: true });
  }

  return {
    root,
    config,
    projects,
    moduleOptions: {
      config,
      prefs: { read: () => ({}) },
      factoryState: {
        discoverProfiles: () => projects.map((project) => project.id),
        catalog: async () => ({ routes: ['feature'], catalogHash: 'b'.repeat(64) }),
      },
      projectsService: {
        list: async () => projects,
        read: async (id) => projects.find((project) => project.id === id),
        withReferences: async (operation) => operation(),
      },
    },
  };
}
