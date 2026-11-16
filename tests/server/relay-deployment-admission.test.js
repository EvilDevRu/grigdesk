import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, readDeployment, setupInput, waitDeployment,
} from './helpers/relayDeployment.js';

for (const action of ['retry', 'probe']) {
  for (const scope of ['relay', 'endpoint']) {
    test(`RD-ADMISSION-01: ${action} не обходит активное задание по ${scope}`, async (t) => {
      const f = await deploymentFixture(t);
      const relay = scope === 'relay' ? await f.mobile.addRelay({
        name: 'Сохранённый доступ',
        host: '127.0.0.1',
        port: 443,
      }) : null;
      const input = setupInput(f, {
        ...(relay ? {
          mode: 'restore',
          name: undefined,
          relayId: relay.id,
        } : {}),
        public: { host: '127.0.0.1', port: 443 },
      });
      const first = await createDeployment(f, input);

      await f.mobile.deploymentService().recover();

      const interrupted = await readDeployment(f, first.id);
      const second = await createDeployment(f, {
        ...input,
        requestId: 'competing-job',
        public: { host: '127.0.0.1', port: scope === 'relay' ? 8443 : 443 },
      });
      const response = await deploymentRequest(f, 'POST', `/${first.id}/${action}`, {
        revision: interrupted.revision,
        ...(action === 'retry' ? { requestId: 'resume-first' } : {}),
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'deployment_busy');
      assert.equal((await readDeployment(f, first.id)).state, 'interrupted');
      assert.equal((await readDeployment(f, second.id)).state, 'draft');
    });
  }

  test(`RD-ADMISSION-01: ${action} исключает собственное задание из busy`, async (t) => {
    const f = await deploymentFixture(t);
    const first = await createDeployment(f);

    await f.mobile.deploymentService().recover();

    const interrupted = await readDeployment(f, first.id);
    const response = await deploymentRequest(f, 'POST', `/${first.id}/${action}`, {
      revision: interrupted.revision,
      ...(action === 'retry' ? { requestId: 'resume-only-job' } : {}),
    });

    assert.ok([200, 202].includes(response.statusCode), response.body);
    assert.notEqual((await readDeployment(f, first.id)).state, 'interrupted');
  });
}

test('RD-ADMISSION-02: два одновременных retry принимают только одного владельца endpoint', async (t) => {
  const f = await deploymentFixture(t);
  const first = await createDeployment(f);

  await f.mobile.deploymentService().recover();

  const second = await createDeployment(f, setupInput(f, { requestId: 'second-interrupted' }));

  await f.mobile.deploymentService().recover();

  const [one, two] = await Promise.all([first, second].map((job) => readDeployment(f, job.id)));
  const results = await Promise.all([one, two].map((job) => deploymentRequest(f, 'POST',
    `/${job.id}/retry`, { revision: job.revision, requestId: `resume-${job.id}` })));

  assert.deepEqual(results.map((response) => response.statusCode).sort(), [202, 409]);
  assert.equal((await f.mobile.deploymentService().list()).filter((job) => job.state === 'draft').length, 1);
});

test('RD-ADMISSION-02: конкурентное создание во время SSH probe проверяется при записи', async (t) => {
  let release;
  let reached;
  const waiting = new Promise((resolve) => release = resolve);
  const started = new Promise((resolve) => reached = resolve);
  const f = await deploymentFixture(t, { transport: {
    probe: async (input) => {
      reached();
      await waiting;

      return {
        ...input,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:fixture',
      };
    },
  } });

  t.after(() => release());

  const first = await createDeployment(f);

  await f.mobile.deploymentService().recover();

  const interrupted = await readDeployment(f, first.id);
  const probing = deploymentRequest(f, 'POST', `/${first.id}/probe`, {
    revision: interrupted.revision,
  });

  await started;
  await createDeployment(f, setupInput(f, { requestId: 'created-during-probe' }));
  release();

  const response = await probing;

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'deployment_busy');
  assert.equal((await readDeployment(f, first.id)).state, 'interrupted');
});

test('RD-DNS-01: proof нового VPS предшествует ожиданию ещё не созданного публичного DNS', async (t) => {
  let proofs = 0;
  const f = await deploymentFixture(t, { deployment: { verifyCandidate: async ({ relay }) => {
    proofs += 1;
    assert.equal(relay.host, '127.0.0.1');

    return { verified: true, address: relay.host };
  } } });
  const relay = await f.mobile.addRelay({
    name: 'Прежний доступ',
    host: '127.0.0.1',
    port: 443,
  });
  const job = await createDeployment(f, setupInput(f, {
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    public: { host: 'new-relay.example.invalid', port: 443 },
    candidateHost: '127.0.0.1',
  }));

  await f.mobile.deploymentService().promote(job, await f.mobile.relay(relay.id), 0);

  const waiting = await readDeployment(f, job.id);

  assert.equal(proofs, 1);
  assert.equal(waiting.state, 'awaiting_dns');
  assert.equal(waiting.error.code, 'update_dns');
  assert.equal((await f.mobile.relay(relay.id)).host, '127.0.0.1');

  const response = await deploymentRequest(f, 'POST', `/${job.id}/check`, {
    revision: waiting.revision,
    requestId: 'retry-public-dns',
  });

  assert.equal(response.statusCode, 202, response.body);
  await waitDeployment(f, job.id, ['awaiting_dns']);
});

test('RD-DNS-01: ожидание публичного DNS не поглощает отказ VPN-guard', async (t) => {
  let proofs = 0;
  const f = await deploymentFixture(t, {
    mobile: { vpnGate: async () => false },
    deployment: { verifyCandidate: async () => {
      proofs += 1;

      return { verified: true, address: '127.0.0.1' };
    } },
  });
  const relay = await f.mobile.addRelay({
    name: 'Прежний доступ',
    host: '127.0.0.1',
    port: 443,
  });
  const job = await createDeployment(f, setupInput(f, {
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    public: { host: '203.0.113.10', port: 443 },
    candidateHost: '127.0.0.1',
  }));

  const stored = await f.mobile.relay(relay.id);

  await assert.rejects(() => f.mobile.deploymentService().promote(job, stored, 0), /waiting_vpn/);
  assert.equal(proofs, 1);
  assert.equal((await readDeployment(f, job.id)).state, 'draft');
});
