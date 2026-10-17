import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { normalizeGitUrl } from '../../server/src/lib/pluginInstall/gitUrl.ts';

test('U1: HTTPS host нормализуется, регистр пути сохраняется', () => {
  assert.equal(normalizeGitUrl(' https://Git.Example.invalid/Team/demo.git/ '),
    'https://git.example.invalid/Team/demo.git');
});

/**
 * Любой отказ адреса имеет один безопасный код без исходной строки.
 * Вызов команды отсутствует: нормализация — чистая граница до запуска Git.
 */
function rejects(raw) {
  assert.throws(() => normalizeGitUrl(raw), (error) => {
    assert.equal(error.code, 'source_url_invalid');
    assert.equal(error.message.includes('fixture-secret'), false);

    return true;
  });
}

/**
 * Новые поддерживаемые формы должны пройти именно нормализацию продукта.
 * doesNotThrow превращает ошибочный отказ в целевой assert для TDD.
 */
function accepts(raw, expected) {
  let result;

  assert.doesNotThrow(() => {
    result = normalizeGitUrl(raw);
  });
  assert.equal(result, expected);
}

test('U2: HTTPS userinfo и секреты отвергаются безопасным сообщением', () => {
  rejects('https://user:fixture-secret@git.example.invalid/team/demo.git');
  rejects('https://user@git.example.invalid/team/demo.git');
  rejects('https://@git.example.invalid/team/demo.git');
});

test('U3: неподдерживаемые схемы и bare paths не становятся Git transport', () => {
  for (const raw of ['http://git.example.invalid/demo', 'git://git.example.invalid/demo',
    'ext::fixture-secret', 'ftp://git.example.invalid/demo', './demo', '/tmp/demo']) {
    rejects(raw);
  }
});

test('U4: короткий SSH адрес принимает допустимый путь и отвергает traversal/option', () => {
  accepts('git@git.example.invalid:team/demo.git', 'git@git.example.invalid:team/demo.git');
  rejects('git@git.example.invalid:team/../demo.git');
  rejects('git@git.example.invalid:-option');
});

test('U5: полный SSH адрес сохраняет user/port и отвергает пароль', () => {
  accepts('ssh://git@git.example.invalid:2222/team/demo.git',
    'ssh://git@git.example.invalid:2222/team/demo.git');
  rejects('ssh://git:fixture-secret@git.example.invalid/team/demo.git');
});

test('U6: file URL требует абсолютный путь без host и корня', () => {
  const url = pathToFileURL('/tmp/demo/origin.git').href;

  accepts(url, url);
  rejects('file://git.example.invalid/tmp/demo');
  rejects('file://localhost/tmp/demo');
  rejects('file:///');
  rejects('/tmp/demo');
});

test('U7: размер, тип, whitespace и control bytes проверяются до парсера URL', () => {
  rejects('');
  rejects(null);
  rejects({ toString: () => 'https://git.example.invalid/demo' });
  rejects(`https://git.example.invalid/${'a'.repeat(512)}`);
  rejects('https://git.example.invalid/team/with space');
  rejects('https://git.example.invalid/team/demo\n.git');
  rejects('https://git.example.invalid/team/demo\u0000.git');
  rejects('-https://git.example.invalid/demo');
});

test('U8: query/fragment и пустой путь отвергнуты, IPv6/port/encoding сохранены', () => {
  rejects('https://git.example.invalid/demo?token=fixture-secret');
  rejects('https://git.example.invalid/demo#ref');
  rejects('https://git.example.invalid/demo?');
  rejects('ssh://git@git.example.invalid/');
  rejects('https://git.example.invalid');
  accepts('https://[::1]:8443/team/encoded%20path.git/',
    'https://[::1]:8443/team/encoded%20path.git');
  accepts('ssh://git@[::1]:2222/team/demo.git', 'ssh://git@[::1]:2222/team/demo.git');
});

test('U9: SSH user/host не допускают option injection и decoded control bytes', () => {
  rejects('-git@git.example.invalid:team/demo.git');
  rejects('git@-git.example.invalid:team/demo.git');
  rejects('ssh://-git@git.example.invalid/team/demo.git');
  rejects('ssh://%2Dgit@git.example.invalid/team/demo.git');
  rejects('ssh://git@-git.example.invalid/team/demo.git');
  rejects('ssh://git@%2Dgit.example.invalid/team/demo.git');
  rejects('ssh://%0agit@git.example.invalid/team/demo.git');
  rejects('ssh://git@%0agit.example.invalid/team/demo.git');
  rejects('ssh:///team/demo.git');
});
