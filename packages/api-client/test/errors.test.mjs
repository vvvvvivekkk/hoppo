// Unit checks for the ApiError getters. The package has no test runner of its
// own, so this uses node:test and compiles src/errors.ts with the TypeScript
// already installed for typecheck.
//
//   pnpm --filter @hoppo/api-client test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const source = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
new Function('module', 'exports', outputText)(mod, mod.exports);
const { ApiError, NetworkError } = mod.exports;

const err = (code, status = 409) => new ApiError(status, code, 'message');

// Each code below is one the API emits: dispatch.service.ts (offer codes),
// orders.service.ts (stale state), jwt.strategy.ts / auth.service.ts (account).
const OFFER_GONE = [
  'OFFER_EXPIRED',
  'NOT_OFFERED_TO_YOU',
  'NOT_YET_OFFERED',
  'OFFER_CLOSED',
  'TASK_CANCELLED',
  'TASK_FINISHED',
];

test('isOfferGone is true for every code that ends an offer', () => {
  for (const code of OFFER_GONE) assert.equal(err(code).isOfferGone, true, code);
});

test('isOfferGone leaves ALREADY_TAKEN and unrelated codes alone', () => {
  for (const code of ['ALREADY_TAKEN', 'TASK_NOT_ACCEPTABLE', 'ORDER_STATE_CHANGED', 'ERROR']) {
    assert.equal(err(code).isOfferGone, false, code);
  }
  assert.equal(err('ALREADY_TAKEN').isAlreadyTaken, true);
});

test('isStaleState covers the two order-moved-on codes only', () => {
  assert.equal(err('ORDER_STATE_CHANGED').isStaleState, true);
  assert.equal(err('ORDER_NOT_READY').isStaleState, true);
  assert.equal(err('OFFER_EXPIRED').isStaleState, false);
  assert.equal(err('ERROR').isStaleState, false);
});

test('isAccountBlocked and accountBlocked agree', () => {
  assert.equal(err('ACCOUNT_SUSPENDED', 401).isAccountBlocked, true);
  assert.equal(err('ACCOUNT_SUSPENDED', 401).accountBlocked, 'SUSPENDED');
  assert.equal(err('ACCOUNT_DEACTIVATED', 401).isAccountBlocked, true);
  assert.equal(err('ACCOUNT_DEACTIVATED', 401).accountBlocked, 'DEACTIVATED');
  // A plain expired session is an auth failure but not a blocked account.
  const expired = err('ERROR', 401);
  assert.equal(expired.isAuthFailure, true);
  assert.equal(expired.isAccountBlocked, false);
  assert.equal(expired.accountBlocked, null);
});

test('a network error is none of these', () => {
  const e = new NetworkError('offline');
  assert.equal(e.isOfferGone, false);
  assert.equal(e.isStaleState, false);
  assert.equal(e.isAccountBlocked, false);
});
