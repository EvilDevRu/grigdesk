// GitHub REST provider primitives: сеть полностью подменена, проверяем точный
// протокол, пределы байтов и отсутствие PAT в ошибках.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_API_VERSION,
  GitHubApiError,
  callGitHubApi,
  createRepositoryHook,
  deleteRepositoryHook,
  getRepository,
  getRepositoryHook,
  listRepositoryHooks,
  listRepositoryIssues,
  listRepositoryIssuesPage,
  pingRepositoryHook,
  updateRepositoryHook,
} from '../../server/src/lib/github/api.ts';

const TOKEN = 'github_pat_11AA00_reallySecretValue9876';
const OWNER = 'example-org';
const REPO = 'example-repo';
const SECRET = 'server-generated-webhook-secret';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('getRepository отправляет точные GitHub REST headers и не кладёт PAT в URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ id: 123456, full_name: `${OWNER}/${REPO}`, has_issues: true });
  };

  const repository = await getRepository(TOKEN, OWNER, REPO, { fetchImpl });
  assert.equal(repository.id, 123456);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${OWNER}/${REPO}`);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(calls[0].options.headers, {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${TOKEN}`,
    'User-Agent': 'cockpit-github-channel/1',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
});

test('createRepositoryHook создаёт только web/issues hook с HTTPS и SSL verification', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ id: 998877, active: false }, 201);
  };

  const hook = await createRepositoryHook(TOKEN, OWNER, REPO, {
    url: 'https://cockpit.example.test/hooks/github/ingress_abc',
    secret: SECRET,
  }, { fetchImpl });

  assert.equal(hook.id, 998877);
  assert.equal(calls[0].url, `https://api.github.com/repos/${OWNER}/${REPO}/hooks`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: 'web',
    active: false,
    events: ['issues'],
    config: {
      url: 'https://cockpit.example.test/hooks/github/ingress_abc',
      content_type: 'json',
      insecure_ssl: '0',
      secret: SECRET,
    },
  });
});

test('createRepositoryHook отвергает HTTP и callback с query до fetch', async (t) => {
  for (const url of [
    'http://cockpit.example.test/hook',
    'https://cockpit.example.test/hook?account=123',
  ]) {
    await t.test(url, async () => {
      let fetched = false;
      await assert.rejects(
        () => createRepositoryHook(TOKEN, OWNER, REPO, {
          url,
          secret: SECRET,
        }, { fetchImpl: async () => { fetched = true; } }),
        (error) => error instanceof GitHubApiError && error.code === 'github_bad_input',
      );
      assert.equal(fetched, false);
    });
  }
});

test('hook get/update/ping/delete используют только точный hook ID', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ id: 55, active: false }),
    jsonResponse({ id: 55, active: true }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    jsonResponse({ message: 'Not Found' }, 404),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  };

  assert.equal((await getRepositoryHook(TOKEN, OWNER, REPO, '55', { fetchImpl })).id, 55);
  assert.equal((await updateRepositoryHook(
    TOKEN,
    OWNER,
    REPO,
    '55',
    { active: true },
    { fetchImpl },
  )).active, true);
  assert.equal(await pingRepositoryHook(TOKEN, OWNER, REPO, '55', { fetchImpl }), undefined);
  assert.deepEqual(await deleteRepositoryHook(TOKEN, OWNER, REPO, '55', { fetchImpl }), {
    deleted: true,
    missing: false,
  });
  assert.deepEqual(await deleteRepositoryHook(TOKEN, OWNER, REPO, '55', { fetchImpl }), {
    deleted: false,
    missing: true,
  });

  assert.deepEqual(calls.map(({ url, options }) => ({
    suffix: url.slice(url.indexOf('/repos/')),
    method: options.method,
    body: options.body === undefined ? undefined : JSON.parse(options.body),
  })), [
    { suffix: `/repos/${OWNER}/${REPO}/hooks/55`, method: 'GET', body: undefined },
    {
      suffix: `/repos/${OWNER}/${REPO}/hooks/55`,
      method: 'PATCH',
      body: { events: ['issues'], active: true },
    },
    { suffix: `/repos/${OWNER}/${REPO}/hooks/55/pings`, method: 'POST', body: undefined },
    { suffix: `/repos/${OWNER}/${REPO}/hooks/55`, method: 'DELETE', body: undefined },
    { suffix: `/repos/${OWNER}/${REPO}/hooks/55`, method: 'DELETE', body: undefined },
  ]);
});

test('list hooks и reconciliation issues имеют bounded pagination и фиксированную сортировку', async () => {
  const calls = [];
  const responses = [jsonResponse([{ id: 1 }]), jsonResponse([{ id: 2 }, { id: 3 }])];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responses.shift();
  };

  assert.deepEqual(await listRepositoryHooks(TOKEN, OWNER, REPO, {
    page: 2,
    perPage: 25,
    fetchImpl,
  }), [{ id: 1 }]);
  assert.deepEqual(await listRepositoryIssues(TOKEN, OWNER, REPO, {
    page: 3,
    perPage: 100,
    fetchImpl,
  }), [{ id: 2 }, { id: 3 }]);

  assert.equal(calls[0],
    `https://api.github.com/repos/${OWNER}/${REPO}/hooks?per_page=25&page=2`);
  assert.equal(calls[1],
    `https://api.github.com/repos/${OWNER}/${REPO}/issues?state=all&sort=created&direction=desc&per_page=100&page=3`);
  assert.ok(!calls[1].includes('since='), '`since` у GitHub относится к updated_at и запрещён');
});

test('issues page следует exact provider Link и возвращает только safe nextPath', async () => {
  const calls = [];
  const nextUrl = 'https://api.github.com/repositories/123456/issues?state=all&sort=created&direction=desc&per_page=2&page=2';
  const lastUrl = 'https://api.github.com/repositories/123456/issues?state=all&sort=created&direction=desc&per_page=2&page=9';
  const responses = [
    jsonResponse([{ id: 1 }], 200, {
      Link: `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`,
    }),
    jsonResponse([{ id: 2 }]),
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responses.shift();
  };

  const first = await listRepositoryIssuesPage(TOKEN, OWNER, REPO, {
    page: 1,
    perPage: 2,
    fetchImpl,
  });
  assert.deepEqual(first, {
    issues: [{ id: 1 }],
    nextPath: '/repositories/123456/issues?state=all&sort=created&direction=desc&per_page=2&page=2',
  });

  const second = await listRepositoryIssuesPage(TOKEN, OWNER, REPO, {
    nextPath: first.nextPath,
    fetchImpl,
  });
  assert.deepEqual(second, { issues: [{ id: 2 }], nextPath: null });
  assert.equal(calls[1], nextUrl);
});

test('foreign, malformed и неоднозначный Link fail-closed', async (t) => {
  const cases = [
    '<https://evil.example/repos/a/b/issues?page=2>; rel="next"',
    '<not-an-absolute-url>; rel="next"',
    '<https://api.github.com/repos/a/b/issues?page=2>; rel=next',
    '<https://api.github.com/repos/a/b/issues?page=2>; rel="next", '
      + '<https://api.github.com/repos/a/b/issues?page=3>; rel="next"',
  ];

  for (const link of cases) {
    await t.test(link, async () => {
      const fetchImpl = async () => jsonResponse([], 200, { Link: link });
      await assert.rejects(
        () => listRepositoryIssuesPage(TOKEN, OWNER, REPO, { fetchImpl }),
        (error) => error.code === 'github_link_invalid',
      );
    });
  }

  let fetched = false;
  await assert.rejects(
    () => listRepositoryIssuesPage(TOKEN, OWNER, REPO, {
      nextPath: '/user',
      fetchImpl: async () => { fetched = true; },
    }),
    (error) => error.code === 'github_bad_input',
  );
  assert.equal(fetched, false);
});

test('известный oversize Content-Length отвергается до чтения response body', async () => {
  let bodyRead = false;
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? '6' : null) },
    body: {
      getReader() {
        bodyRead = true;
        return { read: async () => ({ done: true }) };
      },
    },
  });

  await assert.rejects(
    () => callGitHubApi(TOKEN, '/repos/a/b', { fetchImpl, maxResponseBytes: 5 }),
    (error) => error.code === 'github_response_too_large' && error.limit === 5,
  );
  assert.equal(bodyRead, false);
});

test('фактический response body ограничен при пустом Content-Length', async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"long":'));
      controller.enqueue(encoder.encode('"value"}'));
      controller.close();
    },
  }), { status: 200 });

  await assert.rejects(
    () => callGitHubApi(TOKEN, '/repos/a/b', { fetchImpl, maxResponseBytes: 8 }),
    (error) => error.code === 'github_response_too_large',
  );
});

test('request body ограничен до fetch', async () => {
  let fetched = false;
  await assert.rejects(
    () => callGitHubApi(TOKEN, '/repos/a/b/hooks', {
      method: 'POST',
      body: { value: '1234567890' },
      maxRequestBytes: 5,
      fetchImpl: async () => { fetched = true; },
    }),
    (error) => error.code === 'github_request_too_large',
  );
  assert.equal(fetched, false);
});

test('transport и provider errors не раскрывают PAT', async () => {
  const transport = async () => { throw new Error(`connect ${TOKEN} refused`); };
  await assert.rejects(
    () => getRepository(TOKEN, OWNER, REPO, { fetchImpl: transport }),
    (error) => {
      assert.equal(error.code, 'github_unreachable');
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message, /…9876/u);
      return true;
    },
  );

  const rejected = async () => jsonResponse({
    message: `Bad credentials: ${TOKEN}`,
    documentation_url: 'https://docs.github.com/rest',
  }, 403);
  await assert.rejects(
    () => getRepository(TOKEN, OWNER, REPO, { fetchImpl: rejected }),
    (error) => {
      assert.equal(error.code, 'github_forbidden');
      assert.equal(error.status, 403);
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message, /…9876/u);
      assert.equal(error.documentationUrl, 'https://docs.github.com/rest');
      return true;
    },
  );
});
