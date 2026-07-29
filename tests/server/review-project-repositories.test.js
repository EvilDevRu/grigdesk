import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubSlugFromRemote,
  normalizeReviewBinding,
  reviewBindingConflict,
} from '../../server/src/lib/projects.js';

test('MAP-02: SSH и HTTPS remote дают один GitHub slug без учётных данных', () => {
  const urls = [
    'git@github.com:arsenkin21/projects_at_fe.git',
    'ssh://git@github.com/arsenkin21/projects_at_fe.git',
    'https://github.com/arsenkin21/projects_at_fe.git',
    'https://secret-token@github.com/arsenkin21/projects_at_fe.git',
  ];

  assert.deepEqual(urls.map(githubSlugFromRemote), [
    'arsenkin21/projects_at_fe',
    'arsenkin21/projects_at_fe',
    'arsenkin21/projects_at_fe',
    'arsenkin21/projects_at_fe',
  ]);
  assert.equal(githubSlugFromRemote('ssh://git@git.example.test/team/repo.git'), '');
  assert.equal(githubSlugFromRemote('https://github.com/owner'), '');
});

test('MAP-03: найденная привязка остаётся неподтверждённой', () => {
  assert.deepEqual(normalizeReviewBinding({
    detectedSlug: 'Owner/Repo',
  }), {
    slug: '',
    detectedSlug: 'Owner/Repo',
    confirmed: false,
    autoSync: false,
    autoAnalyze: false,
    verifyCommands: [],
    verifyCoversCriteria: false,
  });
});

test('MAP-04: подтверждённая привязка нормализуется без потери настроек', () => {
  assert.deepEqual(normalizeReviewBinding({
    slug: 'Owner/Repo.git',
    detectedSlug: 'Owner/Repo',
    confirmed: true,
    autoSync: true,
    autoAnalyze: true,
    verifyCommands: ['npm test', '', ' npm run build '],
    verifyCoversCriteria: true,
  }), {
    slug: 'Owner/Repo',
    detectedSlug: 'Owner/Repo',
    confirmed: true,
    autoSync: true,
    autoAnalyze: true,
    verifyCommands: ['npm test', 'npm run build'],
    verifyCoversCriteria: true,
  });
});

test('MAP-05: расхождение remote блокирует рабочую привязку', () => {
  assert.deepEqual(normalizeReviewBinding({
    slug: 'Owner/Old',
    detectedSlug: 'Owner/New',
    remoteChecked: true,
    confirmed: true,
    autoSync: true,
    autoAnalyze: true,
  }), {
    slug: 'Owner/Old',
    detectedSlug: 'Owner/New',
    confirmed: false,
    mismatch: true,
    autoSync: false,
    autoAnalyze: false,
    verifyCommands: [],
    verifyCoversCriteria: false,
  });
});

test('MAP-05: пропавший или non-GitHub origin снимает подтверждение fail-closed', () => {
  assert.deepEqual(normalizeReviewBinding({
    slug: 'Owner/Old',
    detectedSlug: '',
    remoteChecked: true,
    confirmed: true,
    autoSync: true,
    autoAnalyze: true,
  }), {
    slug: 'Owner/Old',
    detectedSlug: '',
    confirmed: false,
    mismatch: true,
    autoSync: false,
    autoAnalyze: false,
    verifyCommands: [],
    verifyCoversCriteria: false,
  });
});

test('MAP-06: один GitHub repository нельзя привязать к двум паспортам', () => {
  const projects = {
    alpha: {
      review: {
        repositories: {
          fe: { slug: 'Owner/Repo', confirmed: true },
        },
      },
    },
    beta: {
      review: {
        repositories: {
          be: { slug: 'owner/other', confirmed: true },
        },
      },
    },
  };

  assert.deepEqual(reviewBindingConflict(projects, {
    projectId: 'beta',
    repoKey: 'fe',
    slug: 'owner/repo',
  }), { projectId: 'alpha', repoKey: 'fe' });
  assert.equal(reviewBindingConflict(projects, {
    projectId: 'alpha',
    repoKey: 'fe',
    slug: 'owner/repo',
  }), null);
});
