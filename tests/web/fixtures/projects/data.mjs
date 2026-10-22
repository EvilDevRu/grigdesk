// Визуальная проверка использует вымышленные проекты и пути.
// Снимки каталога и карточки согласованы по одному набору данных.
export const project = {
  id: 'atlas',
  title: 'Атлас',
  description: 'Рабочие инструменты команды: сайт и сервисы.',
  tags: ['продукт', 'команда'],
  repos: [
    {
      key: 'backend',
      dir: '/srv/projects/atlas/backend',
      exists: true,
    },
    {
      key: 'web',
      dir: '/srv/projects/atlas/web',
      exists: true,
    },
  ],
  defaultRepoKey: 'backend',
  archivedAt: null,
  revision: 3,
  updatedAt: '2026-10-20T10:00:00Z',
  createdAt: '2026-09-01T10:00:00Z',
  importStatus: 'none',
  import: {
    status: 'none',
    fingerprint: null,
    at: null,
    error: null,
    candidates: null,
  },
  profile: {
    present: true,
    pathsSource: 'passport',
    readable: true,
    repos: [],
    capabilities: [],
    mismatch: [],
  },
  routes: ['review'],
  warnings: [],
};

export const projects = [project, ...[
  ['design', 'Дизайн-система', false],
  ['mobile', 'Мобильное приложение', false],
  ['docs', 'Документация команды', false],
  ['portal', 'Клиентский портал', false],
  ['archive', 'Старый сайт', true],
].map(([id, title, archived]) => ({
  ...project,
  id,
  title,
  repos: [],
  defaultRepoKey: null,
  profile: { ...project.profile, present: false },
  archivedAt: archived ? '2026-10-01T10:00:00Z' : null,
}))];

export const responses = { '/api/projects': { projects } };

for (const item of projects) {
  responses[`/api/projects/${item.id}`] = item;
  responses[`/api/projects/${item.id}/dependencies`] = {
    items: [],
    archivable: true,
    deletable: false,
    reasons: [],
  };
}
