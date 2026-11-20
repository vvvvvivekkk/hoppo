// Two checks that need no running API:
//  1. each wrapper issues the method and path the API controller declares;
//  2. the exported types have the shapes the API sends (types.typetest.ts,
//     compiled here with the package's own tsconfig).
//
//   pnpm --filter @hoppo/api-client test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = dirname(fileURLToPath(import.meta.url));

function loadEndpoints() {
  const source = readFileSync(resolve(here, '../src/endpoints.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, () => ({}));
  return mod.exports.endpoints;
}

function recordingClient() {
  const calls = [];
  const verb = (method) => (path, ...rest) => {
    calls.push({ method, path, rest });
    return Promise.resolve(undefined);
  };
  return {
    calls,
    get: verb('GET'),
    post: verb('POST'),
    patch: verb('PATCH'),
    put: verb('PUT'),
    delete: verb('DELETE'),
    anonymousPost: verb('POST'),
  };
}

test('admin.radius reads GET /admin/college/radius with nothing attached', async () => {
  const client = recordingClient();
  const api = loadEndpoints()(client);

  assert.equal(typeof api.admin.radius, 'function');
  await api.admin.radius();

  assert.deepEqual(client.calls, [{ method: 'GET', path: '/admin/college/radius', rest: [] }]);
});

test('admin.updateRadius is still the PATCH on the same path', async () => {
  const client = recordingClient();
  await loadEndpoints()(client).admin.updateRadius(2500);

  assert.deepEqual(client.calls, [
    { method: 'PATCH', path: '/admin/college/radius', rest: [{ serviceableRadiusM: 2500 }] },
  ]);
});

// Every wrapper added for the A1 (admin orders), A2 (escalations) and A5
// (admin, platform, privacy, account) contracts: where it lives, how it is
// called, and the request it must issue. `rest` is what follows the path.
const ID = 'id-1';
const CONTRACT_ROUTES = [
  // A1-CONTRACT-admin-orders.md
  ['admin.orders.list', [], 'GET', '/admin/orders', [{ status: undefined }]],
  [
    'admin.orders.list',
    [{ status: ['PLACED', 'PREPARING'], from: '2026-11-01', q: '7f3k', limit: 10 }],
    'GET',
    '/admin/orders',
    [{ status: 'PLACED,PREPARING', from: '2026-11-01', q: '7f3k', limit: 10 }],
  ],
  ['admin.orders.summary', [{ from: '2026-11-01', to: '2026-11-20' }], 'GET', '/admin/orders/summary', [{ from: '2026-11-01', to: '2026-11-20' }]],
  ['admin.orders.detail', [ID], 'GET', `/admin/orders/${ID}`, []],
  ['shops.orderHistory', [ID], 'GET', `/shops/${ID}/orders/history`, [{ status: undefined }]],
  ['shops.orderHistory', [ID, { status: 'CANCELLED', cursor: 'c' }], 'GET', `/shops/${ID}/orders/history`, [{ status: 'CANCELLED', cursor: 'c' }]],
  // A2-CONTRACT-escalations.md
  ['admin.escalations.list', [50, 'c'], 'GET', '/admin/escalations', [{ limit: 50, cursor: 'c' }]],
  ['admin.escalations.detail', [ID], 'GET', `/admin/escalations/${ID}`, []],
  ['admin.escalations.resolve', [ID, 'DELIVERED', 'Called both of them.'], 'POST', `/admin/escalations/${ID}/resolve`, [{ outcome: 'DELIVERED', note: 'Called both of them.' }]],
  // A5-CONTRACT-admin.md section 1
  ['admin.config.get', [], 'GET', '/admin/college/config', []],
  ['admin.config.update', [{ maxOtpAttempts: 4 }], 'PATCH', '/admin/college/config', [{ maxOtpAttempts: 4 }]],
  // section 2
  ['admin.deliveryPoints.list', [], 'GET', '/admin/delivery-points', []],
  ['admin.deliveryPoints.create', [{ name: 'Library', latitude: 17.3, longitude: 78.6 }], 'POST', '/admin/delivery-points', [{ name: 'Library', latitude: 17.3, longitude: 78.6 }]],
  ['admin.deliveryPoints.update', [ID, { description: null }], 'PATCH', `/admin/delivery-points/${ID}`, [{ description: null }]],
  ['admin.deliveryPoints.deactivate', [ID], 'POST', `/admin/delivery-points/${ID}/deactivate`, [{}]],
  ['admin.deliveryPoints.activate', [ID], 'POST', `/admin/delivery-points/${ID}/activate`, [{}]],
  ['admin.deliveryPoints.reorder', [['a', 'b']], 'PUT', '/admin/delivery-points/order', [{ pointIds: ['a', 'b'] }]],
  // section 3
  ['admin.audit.list', [{ action: 'SHOP_SUSPENDED', limit: 5 }], 'GET', '/admin/audit-log', [{ action: 'SHOP_SUSPENDED', limit: 5 }]],
  ['admin.audit.actions', [], 'GET', '/admin/audit-log/actions', []],
  // section 4
  ['admin.listStudents', [{ q: 'asha' }], 'GET', '/admin/students', [{ q: 'asha' }]],
  ['admin.studentDetail', [ID], 'GET', `/admin/students/${ID}`, []],
  ['admin.listShops', [{ status: 'SUSPENDED' }], 'GET', '/admin/shops', [{ status: 'SUSPENDED' }]],
  ['admin.shopDetail', [ID], 'GET', `/admin/shops/${ID}`, []],
  ['admin.reinstateShop', [ID], 'POST', `/admin/shops/${ID}/reinstate`, [{}]],
  // section 5
  ['privacy.notice', [], 'GET', '/legal/privacy-notice', []],
  ['account.export', [], 'GET', '/account/export', []],
  ['account.delete', ['hunter2hunter2'], 'POST', '/account/delete', [{ password: 'hunter2hunter2' }]],
  // section 6
  ['superAdmin.colleges', [], 'GET', '/platform/colleges', []],
  ['superAdmin.createCollege', [{ name: 'X' }], 'POST', '/platform/colleges', [{ name: 'X' }]],
  ['superAdmin.college', [ID], 'GET', `/platform/colleges/${ID}`, []],
  ['superAdmin.deactivateCollege', [ID, 'Closed for the term'], 'POST', `/platform/colleges/${ID}/deactivate`, [{ reason: 'Closed for the term' }]],
  ['superAdmin.activateCollege', [ID], 'POST', `/platform/colleges/${ID}/activate`, [{}]],
  ['superAdmin.createAdmin', [ID, { name: 'A' }], 'POST', `/platform/colleges/${ID}/admins`, [{ name: 'A' }]],
  ['superAdmin.deactivateAdmin', [ID, 'Left the college'], 'POST', `/platform/admins/${ID}/deactivate`, [{ reason: 'Left the college' }]],
  ['superAdmin.reactivateAdmin', [ID], 'POST', `/platform/admins/${ID}/reactivate`, [{}]],
  // A5-CONTRACT-admin.md section 8 (round 4)
  ['privacy.accept', ['2026-11-20'], 'POST', '/legal/privacy-notice/accept', [{ version: '2026-11-20' }]],
  ['account.updateProfile', [{ name: 'Asha K', avatarKey: null }], 'PATCH', '/account/profile', [{ name: 'Asha K', avatarKey: null }]],
  ['auth.changePassword', ['old-password-1', 'new-password-2'], 'POST', '/auth/password/change', [{ currentPassword: 'old-password-1', newPassword: 'new-password-2' }]],
  ['superAdmin.setAdminPassword', [ID, 'a-long-password'], 'POST', `/platform/admins/${ID}/password`, [{ password: 'a-long-password' }]],
];

for (const [name, args, method, path, rest] of CONTRACT_ROUTES) {
  test(`${name}(${args.length ? '…' : ''}) issues ${method} ${path}`, async () => {
    const client = recordingClient();
    const api = loadEndpoints()(client);
    const wrapper = name.split('.').reduce((node, key) => node?.[key], api);

    assert.equal(typeof wrapper, 'function', `${name} is not a wrapper`);
    await wrapper(...args);

    assert.deepEqual(client.calls, [{ method, path, rest }]);
  });
}

test('registration passes the accepted privacy notice version through', async () => {
  const client = recordingClient();
  await loadEndpoints()(client).auth.register({ name: 'A', privacyNoticeVersion: '2026-11-20' });

  assert.equal(client.calls[0].path, '/auth/register');
  assert.equal(client.calls[0].rest[0].privacyNoticeVersion, '2026-11-20');
});

test('exported types match what the API sends (types.typetest.ts compiles)', () => {
  const configPath = resolve(here, '../tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  const program = ts.createProgram([resolve(here, 'types.typetest.ts')], {
    ...parsed.options,
    noEmit: true,
  });
  const problems = ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file
      ? `${d.file.fileName.split('/').slice(-2).join('/')}:${
          d.file.getLineAndCharacterOfPosition(d.start).line + 1
        } `
      : '';
    return where + ts.flattenDiagnosticMessageText(d.messageText, ' ');
  });
  assert.deepEqual(problems, []);
});
