// How ApiClient treats a session the server has ended. Compiles src/client.ts
// and src/errors.ts with the installed TypeScript and stubs global fetch.
//
//   pnpm --filter @hoppo/api-client test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, deps = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, (id) => deps[id]);
  return mod.exports;
}

const errors = load('errors.ts');
const { ApiClient } = load('client.ts', { './errors': errors });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(responder) {
  const state = { tokens: { accessToken: 'a', refreshToken: 'r' }, cleared: 0, failures: [], calls: [] };
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    state.calls.push(path);
    return responder(path, init);
  };
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    tokens: {
      get: () => state.tokens,
      set: async (t) => void (state.tokens = t),
      clear: async () => {
        state.tokens = null;
        state.cleared += 1;
      },
    },
    onAuthFailure: (error) => state.failures.push(error),
  });
  return { client, state };
}

const INACTIVE = { code: 'COLLEGE_INACTIVE', message: 'This college is not currently active on Hoppo.' };

test('403 COLLEGE_INACTIVE on a signed-in request clears the session and reports why', async () => {
  const { client, state } = setup(() => json(403, INACTIVE));

  await assert.rejects(client.get('/orders'), (e) => e.code === 'COLLEGE_INACTIVE' && e.status === 403);

  assert.equal(state.tokens, null);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].code, 'COLLEGE_INACTIVE');
  // Not retried and not refreshed: one request, no /auth/refresh.
  assert.deepEqual(state.calls, ['/api/v1/orders']);
});

test('403 COLLEGE_INACTIVE at login is only an error: there is no session to end', async () => {
  const { client, state } = setup(() => json(403, INACTIVE));

  await assert.rejects(client.anonymousPost('/auth/login', {}), (e) => e.code === 'COLLEGE_INACTIVE');

  assert.equal(state.cleared, 0);
  assert.equal(state.failures.length, 0);
});

test('an ordinary 403 leaves the session alone', async () => {
  const { client, state } = setup(() => json(403, { code: 'FORBIDDEN', message: 'no' }));

  await assert.rejects(client.get('/admin/orders'), (e) => e.code === 'FORBIDDEN');

  assert.equal(state.cleared, 0);
  assert.equal(state.failures.length, 0);
});

test('409 COLLEGE_INACTIVE (adding an admin to an inactive college) leaves the session alone', async () => {
  const { client, state } = setup(() => json(409, INACTIVE));

  await assert.rejects(client.post('/platform/colleges/c/admins', {}), (e) => e.status === 409);

  assert.equal(state.cleared, 0);
  assert.equal(state.failures.length, 0);
});

test('a refresh refused with COLLEGE_INACTIVE ends the session with that reason', async () => {
  const { client, state } = setup((path) =>
    path.endsWith('/auth/refresh')
      ? json(403, INACTIVE)
      : json(401, { code: 'UNAUTHENTICATED', message: 'expired' }),
  );

  await assert.rejects(client.get('/orders'));

  assert.equal(state.tokens, null);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].code, 'COLLEGE_INACTIVE');
  assert.deepEqual(state.calls, ['/api/v1/orders', '/api/v1/auth/refresh']);
});

test('a suspended account still ends the session through the 401 path', async () => {
  const { client, state } = setup((path) =>
    path.endsWith('/auth/refresh')
      ? json(401, { code: 'REFRESH_INVALID', message: 'no' })
      : json(401, { code: 'ACCOUNT_SUSPENDED', message: 'suspended' }),
  );

  await assert.rejects(client.get('/orders'), (e) => e.code === 'ACCOUNT_SUSPENDED');

  assert.equal(state.tokens, null);
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].accountBlocked, 'SUSPENDED');
});

const EXPIRED = { code: 'UNAUTHENTICATED', message: 'expired' };

// auth.service.ts refresh() can refuse with: REFRESH_INVALID, REFRESH_REUSED,
// REFRESH_EXPIRED, ACCOUNT_UNAVAILABLE (all 401) and COLLEGE_INACTIVE (403).
for (const code of ['ACCOUNT_UNAVAILABLE', 'ACCOUNT_SUSPENDED', 'ACCOUNT_DEACTIVATED']) {
  test(`a refresh refused with ${code} hands that error to onAuthFailure`, async () => {
    const { client, state } = setup((path) =>
      path.endsWith('/auth/refresh')
        ? json(401, { code, message: 'This account is no longer active.' })
        : json(401, EXPIRED),
    );

    // The request itself still fails with what it was answered.
    await assert.rejects(client.get('/orders'), (e) => e.code === 'UNAUTHENTICATED');

    assert.equal(state.tokens, null);
    assert.equal(state.cleared, 1);
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0].code, code);
    assert.equal(state.failures[0].isAccountUnavailable, true);
    assert.equal(state.failures[0].message, 'This account is no longer active.');
  });
}

for (const code of ['REFRESH_INVALID', 'REFRESH_REUSED', 'REFRESH_EXPIRED']) {
  test(`a refresh refused with ${code} is "log in again": cleared once, reported as the 401`, async () => {
    const { client, state } = setup((path) =>
      path.endsWith('/auth/refresh') ? json(401, { code, message: 'no' }) : json(401, EXPIRED),
    );

    await assert.rejects(client.get('/orders'), (e) => e.code === 'UNAUTHENTICATED');

    // Exactly what is cleared: the token store, through TokenStore.clear(), once.
    assert.equal(state.tokens, null);
    assert.equal(state.cleared, 1);
    // One onAuthFailure, carrying the request's own 401 — nothing about the account.
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0].code, 'UNAUTHENTICATED');
    assert.equal(state.failures[0].accountBlocked, null);
    // One attempt at the request, one at the refresh, no retry.
    assert.deepEqual(state.calls, ['/api/v1/orders', '/api/v1/auth/refresh']);
  });
}

test('a refusal from an earlier refresh does not leak into a later sign-out', async () => {
  let refreshAnswer = json(401, { code: 'ACCOUNT_UNAVAILABLE', message: 'gone' });
  const { client, state } = setup((path) =>
    path.endsWith('/auth/refresh') ? refreshAnswer : json(401, EXPIRED),
  );

  await assert.rejects(client.get('/orders'));
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Signed in again as someone else; this time the refresh simply expired.
  state.tokens = { accessToken: 'a2', refreshToken: 'r2' };
  refreshAnswer = json(401, { code: 'REFRESH_EXPIRED', message: 'no' });
  await assert.rejects(client.get('/orders'));

  assert.equal(state.failures.length, 2);
  assert.equal(state.failures[0].code, 'ACCOUNT_UNAVAILABLE');
  assert.equal(state.failures[1].code, 'UNAUTHENTICATED');
});
