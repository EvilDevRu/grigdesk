import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chatAgentsUrl = new URL('../../docs/cockpit/chat-agents.md', import.meta.url);
const gotchasUrl = new URL('../../docs/cockpit/gotchas.md', import.meta.url);
const kimiSecurityUrl = new URL('../../docs/cockpit/kimi-runtime-security.md', import.meta.url);

function missingClauses(text, clauses) {
  return clauses.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
}

test('канон chat-agents описывает настройку, POST и четыре способа запрета SSH', async () => {
  const text = await readFile(chatAgentsUrl, 'utf8');
  const missing = missingClauses(text, [
    ['ключ настройки', /blockDirectSsh/u],
    ['хранение по исполнителю', /providerSettings\.<id>\.blockDirectSsh/u],
    ['существующий POST', /POST \/api\/providers\/:id\/settings/u],
    ['подтверждённое выключение', /confirmed\s*:\s*true/u],
    ['default-on', /(по умолчанию|отсутстви[^\n]*ключ)[^\n]*(включ|true)/iu],
    ['Claude command-hook', /Claude[^\n]*command-hook/iu],
    ['Codex command-hook', /Codex[^\n]*command-hook/iu],
    ['Ollama tool-filter', /Ollama[^\n]*tool-filter/iu],
    ['Kimi network/fail-closed', /Kimi[\s\S]{0,500}(network-sandbox|fail-closed)/iu],
    ['переоткрытие сессии', /providerSettings[\s\S]{0,300}(restart|переоткр)/iu],
  ]);

  assert.deepEqual(missing, []);
});

test('грабли честно ограничивают гарантию и фиксируют конфликт с user deny', async () => {
  const text = await readFile(gotchasUrl, 'utf8');
  const missing = missingClauses(text, [
    ['кооперативный агент', /кооперативн[^\n]*агент/iu],
    ['намеренный обход', /(намеренн[^\n]*обход|base64[^\n]*sh|собственн[^\n]*SSH-клиент)/iu],
    ['независимость от permission mode', /(permission mode|режим[^\n]*прав)[\s\S]{0,220}(не отмен|независ)/iu],
    ['SSH_AUTH_SOCK остаётся', /SSH_AUTH_SOCK[\s\S]{0,180}(оста|не очищ)/iu],
    ['Git по SSH не запрещён', /Git[^\n]*SSH[\s\S]{0,180}(оста|не блок)/iu],
    ['после opt-out нет журнала', /(выключ|снят)[^\n]*запрет[\s\S]{0,250}(журнал|подтвержден)/iu],
    ['старый PWA получает отказ', /стар[^\n]*PWA[\s\S]{0,240}confirmation_required/iu],
    ['пользовательский deny сохранён', /permissions\.deny[\s\S]{0,400}(не отмен|сохрани|оба)/iu],
    ['замер с отдельным config', /(временн|temp)[^\n]*(config|CLAUDE_CONFIG_DIR)[\s\S]{0,400}(deny|запрет)/iu],
  ]);

  assert.deepEqual(missing, []);
});

test('security-канон Kimi различает host fail-closed и contained network invariant', async () => {
  const text = await readFile(kimiSecurityUrl, 'utf8');
  const missing = missingClauses(text, [
    ['ключ настройки', /blockDirectSsh/u],
    ['host fail-closed', /host[\s\S]{0,300}fail-closed/iu],
    ['typed отказ', /direct_ssh_policy_unavailable/u],
    ['contained при false закрыт сетью', /contained[\s\S]{0,500}(false|выключ)[\s\S]{0,300}(egress|сетев|network)/iu],
  ]);

  assert.deepEqual(missing, []);
});
