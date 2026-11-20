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

test('accountBlocked names the state, and an expired session is not one', () => {
  assert.equal(err('ACCOUNT_SUSPENDED', 401).accountBlocked, 'SUSPENDED');
  assert.equal(err('ACCOUNT_DEACTIVATED', 401).accountBlocked, 'DEACTIVATED');
  const expired = err('ERROR', 401);
  assert.equal(expired.isAuthFailure, true);
  assert.equal(expired.accountBlocked, null);
});

test('isAwaitingShopApproval covers both codes the API emits for an unapproved shop', () => {
  // shop-approval.guard.ts and catalog.service.ts respectively.
  assert.equal(err('SHOP_NOT_APPROVED', 403).isAwaitingShopApproval, true);
  assert.equal(err('LISTING_NOT_ACTIVE', 403).isAwaitingShopApproval, true);
  // A rejected or suspended listing is a different answer, as is a plain 403.
  assert.equal(err('LISTING_NOT_EDITABLE', 403).isAwaitingShopApproval, false);
  assert.equal(err('FORBIDDEN', 403).isAwaitingShopApproval, false);
});

test('an unapproved shop is neither an auth failure nor a verification prompt', () => {
  const e = err('SHOP_NOT_APPROVED', 403);
  assert.equal(e.isAuthFailure, false);
  assert.equal(e.needsVerification, false);
  assert.equal(e.isRetryable, false);
});

test('STUDENT_ACCOUNT_REQUIRED does not send anyone to student verification', () => {
  const e = err('STUDENT_ACCOUNT_REQUIRED', 403);
  assert.equal(e.needsVerification, false);
  assert.equal(e.isAwaitingShopApproval, false);
  assert.equal(e.isAuthFailure, false);
  assert.equal(err('VERIFICATION_REQUIRED', 403).needsVerification, true);
});

test('401 UNAUTHENTICATED ends the session; 403 PASSWORD_INCORRECT does not', () => {
  // The API's code for "no valid login" is UNAUTHENTICATED (not UNAUTHORIZED).
  assert.equal(err('UNAUTHENTICATED', 401).isAuthFailure, true);
  assert.equal(err('UNAUTHENTICATED', 401).accountBlocked, null);
  // A wrong current password on change-password or delete-account is a 403
  // about the form, not the session.
  const wrong = err('PASSWORD_INCORRECT', 403);
  assert.equal(wrong.isAuthFailure, false);
  assert.equal(wrong.isRetryable, false);
});

test('403 COLLEGE_INACTIVE ends the session, like a suspended account', () => {
  // jwt.strategy.ts and auth.service.ts (login, refresh) answer a deactivated
  // college's users with 403 COLLEGE_INACTIVE: their tokens are dead.
  const e = err('COLLEGE_INACTIVE', 403);
  assert.equal(e.isAuthFailure, true);
  assert.equal(e.isRetryable, false);
  // It is the college that is blocked, not the account.
  assert.equal(e.accountBlocked, null);
  // For comparison, the case it is modelled on.
  assert.equal(err('ACCOUNT_SUSPENDED', 401).isAuthFailure, true);
});

test('409 COLLEGE_INACTIVE is a refused action, not a dead session', () => {
  // platform.service.ts: a super administrator adding an admin to an
  // inactive college. Their own session is fine.
  assert.equal(err('COLLEGE_INACTIVE', 409).isAuthFailure, false);
});

test('losing an admin race or deleting as a non-student is not an auth failure', () => {
  for (const [code, status] of [
    ['ALREADY_DECIDED', 409],
    ['NOT_ACTIVE', 409],
    ['NOT_SUSPENDED', 409],
    ['ALREADY_SUSPENDED', 409],
    ['ALREADY_RESOLVED', 409],
    ['ACCOUNT_DELETION_NOT_AVAILABLE', 403],
    ['FORBIDDEN', 403],
  ]) {
    assert.equal(err(code, status).isAuthFailure, false, code);
  }
});

test('ACCOUNT_UNAVAILABLE (a refresh refused for a non-active account) is mapped', () => {
  // auth.service.ts refresh(): the user is missing or not ACTIVE. The API does
  // not say which state, so the client must not guess one.
  const e = err('ACCOUNT_UNAVAILABLE', 401);
  assert.equal(e.isAuthFailure, true);
  assert.equal(e.isAccountUnavailable, true);
  assert.equal(e.accountBlocked, null);
  // If the API ever names the state in details, it is believed.
  const named = new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'm', { status: 'DEACTIVATED' });
  assert.equal(named.accountBlocked, 'DEACTIVATED');
  assert.equal(new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'm', { status: 'ACTIVE' }).accountBlocked, null);
});

test('isAccountUnavailable covers every "this account cannot be used" code and nothing else', () => {
  for (const code of ['ACCOUNT_SUSPENDED', 'ACCOUNT_DEACTIVATED', 'ACCOUNT_UNAVAILABLE']) {
    assert.equal(err(code, 401).isAccountUnavailable, true, code);
  }
  for (const [code, status] of [
    ['UNAUTHENTICATED', 401],
    ['REFRESH_INVALID', 401],
    ['REFRESH_REUSED', 401],
    ['REFRESH_EXPIRED', 401],
    ['COLLEGE_INACTIVE', 403],
  ]) {
    const e = err(code, status);
    assert.equal(e.isAccountUnavailable, false, code);
    // ...but each of them does end the session.
    assert.equal(e.isAuthFailure, true, code);
  }
});

test('the getter removed in round two stays removed', () => {
  assert.equal('isAccountBlocked' in err('ACCOUNT_SUSPENDED', 401), false);
});

test('a network error is none of these', () => {
  const e = new NetworkError('offline');
  assert.equal(e.isOfferGone, false);
  assert.equal(e.isStaleState, false);
  assert.equal(e.isAwaitingShopApproval, false);
  assert.equal(e.accountBlocked, null);
});
