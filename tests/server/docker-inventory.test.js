import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupComposeProjects,
  normalizeContainers,
  normalizeImages,
  normalizeNetworks,
  normalizePorts,
  normalizeVolumes,
  summarizeDiskUsage,
} from '../../server/src/lib/docker/inventory.ts';

function rawContainer(overrides = {}) {
  return {
    Id: 'c1',
    Names: ['/app-1'],
    Image: 'app:latest',
    ImageID: 'sha256:image1',
    Created: 1788536132,
    State: 'running',
    Status: 'Up 4 hours',
    Ports: [],
    Labels: {},
    Mounts: [],
    NetworkSettings: { Networks: { bridge: {} } },
    ...overrides,
  };
}

test('порт с двух семейств адресов остаётся одной строкой «наружу → внутрь»', () => {
  const ports = normalizePorts([
    { IP: '0.0.0.0', PrivatePort: 5173, PublicPort: 5191, Type: 'tcp' },
    { IP: '::', PrivatePort: 5173, PublicPort: 5191, Type: 'tcp' },
    { PrivatePort: 9000, Type: 'tcp' },
  ]);

  assert.equal(ports.length, 2);
  assert.deepEqual(ports[0], {
    published: 5191,
    target: 5173,
    protocol: 'tcp',
    hosts: ['0.0.0.0', '::'],
  });
  assert.equal(ports[1].published, 0, 'непроброшенный порт остаётся внутренним');
});

test('compose-группа собирается по лейблам и считает живых, а одиночки в неё не попадают', () => {
  const containers = normalizeContainers([
    rawContainer({
      Id: 'a',
      Names: ['/proj-app-1'],
      Labels: {
        'com.docker.compose.project': 'proj',
        'com.docker.compose.service': 'app',
        'com.docker.compose.project.working_dir': '/srv/proj',
      },
      Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    }),
    rawContainer({
      Id: 'b',
      Names: ['/proj-db-1'],
      State: 'exited',
      Labels: {
        'com.docker.compose.project': 'proj',
        'com.docker.compose.service': 'db',
      },
    }),
    rawContainer({ Id: 'c', Names: ['/lonely'] }),
  ]);
  const projects = groupComposeProjects(containers);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].project, 'proj');
  assert.equal(projects[0].total, 2);
  assert.equal(projects[0].running, 1);
  assert.deepEqual(projects[0].ports, [8080]);
  assert.equal(projects[0].workingDir, '/srv/proj');
  assert.equal(containers.find((item) => item.name === 'lonely').compose, null);
});

test('занятость образа считается по контейнерам, а не по полю демона', () => {
  const containers = normalizeContainers([rawContainer({ ImageID: 'sha256:used' })]);
  const images = normalizeImages([
    { Id: 'sha256:used', RepoTags: ['app:latest'], Size: 100, Containers: 0 },
    { Id: 'sha256:free', RepoTags: [], Size: 300, Containers: 5 },
  ], containers);

  const used = images.find((image) => image.id === 'sha256:used');
  const free = images.find((image) => image.id === 'sha256:free');
  assert.equal(used.inUse, true, 'образ под живым контейнером занят, что бы ни говорило поле Containers');
  assert.deepEqual(used.usedBy, ['app-1']);
  assert.equal(free.inUse, false);
  assert.equal(free.dangling, true, 'образ без тегов — висячий');
});

test('том занят, пока на него ссылается контейнер — в том числе остановленный', () => {
  const containers = normalizeContainers([
    rawContainer({
      Id: 'stopped',
      Names: ['/db-1'],
      State: 'exited',
      Mounts: [{ Type: 'volume', Name: 'data', Destination: '/var/lib/mysql', RW: true }],
    }),
  ]);
  const volumes = normalizeVolumes(
    [
      { Name: 'data', Driver: 'local', Labels: {} },
      { Name: 'orphan', Driver: 'local', Labels: { 'com.docker.volume.anonymous': '' } },
    ],
    { containers, usage: [{ Name: 'data', UsageData: { Size: 4096 } }] },
  );

  const data = volumes.find((volume) => volume.name === 'data');
  const orphan = volumes.find((volume) => volume.name === 'orphan');
  assert.equal(data.inUse, true);
  assert.deepEqual(data.usedBy, ['db-1']);
  assert.equal(data.size, 4096);
  assert.equal(orphan.inUse, false);
  assert.equal(orphan.anonymous, true);
  assert.equal(orphan.size, null, 'без df размер тома неизвестен и не выдумывается');
});

test('встроенные сети не считаются кандидатами на уборку', () => {
  const containers = normalizeContainers([rawContainer()]);
  const networks = normalizeNetworks([
    { Id: 'n1', Name: 'bridge', Driver: 'bridge', IPAM: { Config: [] } },
    { Id: 'n2', Name: 'proj_default', Driver: 'bridge', IPAM: { Config: [{ Subnet: '172.20.0.0/16' }] } },
  ], containers);

  assert.equal(networks.find((item) => item.name === 'bridge').builtin, true);
  assert.equal(networks.find((item) => item.name === 'bridge').containers, 1);
  const project = networks.find((item) => item.name === 'proj_default');
  assert.equal(project.builtin, false);
  assert.deepEqual(project.subnets, ['172.20.0.0/16']);
});

test('сводка берёт освобождаемое у демона, а не складывает размеры образов', () => {
  const containers = normalizeContainers([rawContainer({ ImageID: 'sha256:used' })]);
  const images = normalizeImages([
    { Id: 'sha256:used', RepoTags: ['app:latest'], Size: 1000 },
    { Id: 'sha256:one', RepoTags: ['a:1'], Size: 900 },
    { Id: 'sha256:two', RepoTags: ['b:1'], Size: 900 },
  ], containers);
  const df = {
    ImageUsage: { TotalCount: 3, ActiveCount: 1, TotalSize: 1900, Reclaimable: 950 },
    ContainerUsage: { TotalCount: 1, ActiveCount: 1, TotalSize: 10, Reclaimable: 0 },
    VolumeUsage: { TotalCount: 0, ActiveCount: 0, TotalSize: 0, Reclaimable: 0 },
    BuildCacheUsage: { TotalCount: 12, TotalSize: 5000, Reclaimable: 2000 },
    BuildCache: [{ ID: 'x', InUse: false, Shared: true, Size: 5000 }],
  };

  const summary = summarizeDiskUsage({ df, containers, images, volumes: [], networks: [] });

  assert.equal(summary.source, 'daemon');
  assert.equal(summary.images.reclaimable, 950, 'общие слои учтены демоном, а не сложены дважды');
  assert.notEqual(summary.images.reclaimable, 1800, 'наивная сумма неиспользуемых образов завышена');
  assert.equal(summary.buildCache.reclaimable, 2000, 'общий кэш сборки не считается освобождаемым целиком');
  assert.equal(summary.containers.stopped, 0);
});

test('без полей *Usage сводка честно помечает себя расчётной', () => {
  const containers = normalizeContainers([rawContainer({ State: 'exited' })]);
  const images = normalizeImages([{ Id: 'sha256:x', RepoTags: [], Size: 700 }], containers);
  const summary = summarizeDiskUsage({ df: {}, containers, images, volumes: [], networks: [] });

  assert.equal(summary.source, 'computed');
  assert.equal(summary.containers.stopped, 1);
  assert.equal(summary.images.dangling.count, 1);
  assert.equal(summary.images.dangling.size, 700);
});
