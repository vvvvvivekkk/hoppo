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
