import assert from 'node:assert/strict';
import test from 'node:test';

import { canonDocs } from './helpers/canon.mjs';

async function sshDocs() {
  return canonDocs();
}

async function projectMap() {
  return canonDocs();
}

async function sshGotchas() {
  return canonDocs();
}

test('документация закрепляет пароль только в ручном raw connect', async () => {
  const docs = await sshDocs();

  assert.equal(
    /application\/octet-stream/i.test(docs)
      && /парол[ья][\s\S]{0,240}(?:не хран|не попада)/i.test(docs)
      && /localhost|loopback|HTTPS/i.test(docs),
    true,
  );
});

test('документация разделяет human shell agent exec и SFTP', async () => {
  const docs = await sshDocs();

  assert.equal(
    /shell[\s\S]{0,300}exec/i.test(docs)
      && /SFTP[\s\S]{0,160}(?:только человек|только человеку|human-only)/i.test(docs),
    true,
  );
});

test('документация закрепляет одну очередь и origin-aware ответ', async () => {
  const docs = await sshDocs();

  assert.equal(
    /одн[ау]\s+(?:общая\s+)?очеред/i.test(docs)
      && /origin/i.test(docs)
      && /\/api\/ssh\/approvals\/:pid/.test(docs),
    true,
  );
});

test('документация называет четыре bridge и trusted task scope', async () => {
  const docs = await sshDocs();

  assert.deepEqual({
    providers: ['Claude', 'Codex', 'Kimi', 'Ollama'].filter((name) => docs.includes(name)),
    trustedAttempt: /trusted attempt|доверенн[а-я -]*attempt/i.test(docs),
    nullScope: /free|свободн[а-я ]+чат/i.test(docs),
  }, {
    providers: ['Claude', 'Codex', 'Kimi', 'Ollama'],
    trustedAttempt: true,
    nullScope: true,
  });
});

test('документация честно называет риск prompt injection в выводе сервера', async () => {
  const docs = await sshDocs();

  assert.equal(/prompt injection|инъекц[а-я ]+промпт/i.test(docs), true);
});

test('карта проекта перечисляет раздел SSH и все публичные endpoints плагина', async () => {
  const docs = await projectMap();
  const endpoints = [
    '/api/ssh/connections',
    '/api/ssh/host-key/:challengeId',
    '/api/ssh/sessions',
    '/api/ssh/sessions/:sid/agent-access',
    '/api/ssh/sessions/:sid/terminal',
    '/api/ssh/sessions/:sid/files',
    '/api/ssh/audit',
    '/api/ssh/approvals/:pid',
  ];

  assert.deepEqual({
    hasSection: /^- SSH:|^###? SSH|SSH-плагин/im.test(docs),
    missingEndpoints: endpoints.filter((endpoint) => !docs.includes(endpoint)),
  }, {
    hasSection: true,
    missingEndpoints: [],
  });
});

test('грабли SSH фиксируют все fail-closed границы безопасности', async () => {
  const docs = await sshGotchas();
  const section = docs;
  const boundaries = {
    password: /парол[ьяюе][\s\S]{0,240}(?:не хран|не попад|octet-stream)/i.test(section),
    tofu: /TOFU|host key|known-host/i.test(section),
    untrustedOutput: /prompt injection|недоверен[а-я ]+вывод/i.test(section),
    singleToolHost: /ToolHost[\s\S]{0,240}(?:один|единствен)|(?:один|единствен)[\s\S]{0,240}ToolHost/i.test(section),
    telegramClosed: /Telegram[\s\S]{0,260}(?:fail-closed|не (?:видит|получает|показывает))|(?:fail-closed|закрыт)[\s\S]{0,260}Telegram/i.test(section),
    oldBundleClosed: /(?:стар[а-я ]+бандл|PWA)[\s\S]{0,300}(?:fail-closed|не (?:видит|отвечает|разрешает))/i.test(section),
  };

  assert.deepEqual(boundaries, {
    password: true,
    tofu: true,
    untrustedOutput: true,
    singleToolHost: true,
    telegramClosed: true,
    oldBundleClosed: true,
  });
});
