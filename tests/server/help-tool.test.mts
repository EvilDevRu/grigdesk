import assert from 'node:assert/strict';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { queryHelp } from '../../shared/help/helpQuery.ts';
import { createWorkTools, withHelpToolPolicy } from '../../server/src/lib/executors/index.ts';
import { createWorkMcpHandler } from '../../server/src/lib/executors/work-mcp.js';
import { codexDynamicToolResponse } from '../../server/src/lib/executors/codex.ts';
import { deepSeekWorkActions } from '../../server/src/lib/deepseek/toolPermissionPolicy.ts';
import { withHelpHint } from '../../server/src/lib/chat/helpHint.ts';
import { createRequire } from 'node:module';
import { createHelpService } from '../../server/src/lib/help/service.ts';
import { localeCorpus } from '../helpers/helpLocale.mts';

test('HELP-T1: настоящий registry и два транспорта доставляют один текст/revision', async () => {
  const corpus = await compileHelpSources(new URL('../..', import.meta.url).pathname, {
    version: '0.1.0', commit: 'source'
  });
  const policy = withHelpToolPolicy({
    revision: 1, allowedActions: {
      supervised_ssh: ['list']
    }
  });
  const tools = createWorkTools({
    workToolPolicy: policy,
    helpInvoke: async (input: unknown) => queryHelp(corpus, input)
  });
  const descriptor = tools.descriptors.find((entry) => entry.name === 'grigdesk_help');

  assert.ok(descriptor);
  assert.deepEqual(policy?.allowedActions.supervised_ssh, ['list']);

  const result = await tools.invoke('grigdesk_help', {
    action: 'read', id: 'chats'
  });
  const handler = createWorkMcpHandler({
    workTools: tools
  });
  const response = await handler.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'grigdesk_help', arguments: {
        action: 'read', id: 'chats'
      }
    }
  });

  assert.ok('result' in response);
  assert.ok(Array.isArray(response.result.content));
  assert.deepEqual(JSON.parse(response.result.content[0].text), result);
  assert.equal(codexDynamicToolResponse(result).success, true);
  assert.deepEqual(await tools.invoke('grigdesk_help', {
    action: 'read',
    id: 'chats',
    path: '/etc/passwd'
  }), {
    ok: false, error: 'help_input_invalid'
  });
  assert.deepEqual(deepSeekWorkActions(tools)['mcp__grigdesk-work__grigdesk_help'], {
    index: 'read',
    search: 'read',
    read: 'read'
  });
  assert.equal(createWorkTools().descriptors.some((entry) => entry.name === 'grigdesk_help'), false);
  assert.ok(withHelpHint('x').startsWith('x\n'));
});


test('HELP-T5: отказ server-owned reader не выдаётся за ошибку аргументов модели', async () => {
  const tools = createWorkTools({
    helpInvoke: async () => {
      throw new Error('PRIVATE-SENTINEL');
    },
  });

  assert.deepEqual(await tools.invoke('grigdesk_help', { action: 'index' }), {
    ok: false,
    error: 'help_unavailable',
  });
});


test('HELP-T-L1: опубликованная schema принимает EN, сервис и оба транспорта читают его', async (t) => {
  const help = createHelpService({
    root: '/',
    kind: 'packaged',
    read: async (...args: unknown[]) => {
      return localeCorpus(args[0] === 'en' ? 'en' : 'ru', '0.1.0', 'a'.repeat(11999) + '😀'
        + 'b'.repeat(12001)) as
        Awaited<ReturnType<typeof compileHelpSources>>;
    },
  });
  const tools = createWorkTools({ helpInvoke: help.invoke });
  const descriptor = tools.descriptors.find((entry) => entry.name === 'grigdesk_help')!;
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const Ajv = require('ajv');
  const validate = new Ajv({ strict: false }).compile(descriptor.inputSchema);

  assert.equal(validate({
    action: 'read',
    id: 'chats',
    locale: 'en',
  }), true);
  assert.equal(validate({
    action: 'read',
    id: 'chats',
    locale: 'en',
    path: '/etc/passwd',
  }), false);
  assert.equal(validate({ action: 'index', locale: 'de' }), false);

  const handler = createWorkMcpHandler({ workTools: tools });

  for (const locale of ['ru', 'en']) {
    for (const input of [{ action: 'index', locale },
      {
        action: 'search',
        query: locale === 'en' ? 'working directory' : 'рабочая папка',
        locale,
      },
      {
        action: 'read',
        id: 'chats',
        offset: 0,
        locale,
      }]) {
      const result = await tools.invoke('grigdesk_help', input);
      const response = await handler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'grigdesk_help', arguments: input },
      });

      assert.ok(result && typeof result === 'object');
      assert.ok('ok' in result && 'locale' in result);
      assert.equal(result.ok, true);
      assert.equal(result.locale, locale);
      assert.ok('result' in response);
      assert.deepEqual(JSON.parse(response.result.content[0].text), result);
      assert.equal(codexDynamicToolResponse(result).success, true);
    }

    const parts: string[] = [];
    let offset = 0;

    for (;;) {
      const page = await tools.invoke('grigdesk_help', {
        action: 'read',
        id: 'chats',
        locale,
        offset,
      });

      assert.ok(page && typeof page === 'object');
      assert.ok('ok' in page && 'locale' in page);
      assert.equal(page.ok, true);
      assert.equal(page.locale, locale);
      assert.ok('text' in page && typeof page.text === 'string');
      assert.ok('nextOffset' in page && (page.nextOffset === null || typeof page.nextOffset === 'number'));
      parts.push(page.text);

      if (page.nextOffset === null) {
        break;
      }

      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }

    const expected = localeCorpus(locale === 'en' ? 'en' : 'ru', '0.1.0',
      'a'.repeat(11999) + '😀' + 'b'.repeat(12001));

    assert.equal(parts.join(''), expected.articles[1]!.markdown);
  }

  assert.equal((await help.invoke({ action: 'index' }) as { locale: string }).locale, 'ru');
});
