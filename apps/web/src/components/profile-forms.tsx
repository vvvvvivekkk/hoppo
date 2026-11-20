'use client';

import { useState } from 'react';
import type { AuthUser } from '@hoppo/api-client';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * S-50: the one profile field a student can change — their name.
 *
 * Everything else on the profile is fixed in Phase 1, and for reasons rather
 * than for lack of a form: the mobile number and email are how the account
 * was proven to be a real person at a real college, and the roll number,
 * department and year are what an administrator checked against an ID card.
 * The account screen says that next to them; this form does not pretend
 * otherwise by offering fields the API would refuse.
 *
 * The API answers a profile edit with the same body as `/auth/me`, so the
 * result goes straight into context. No second request, and no moment where
 * the header still shows the old name.
 */
export function NameForm({ user, onDone }: { user: AuthUser; onDone: () => void }) {
  const { api, adoptUser } = useApi();

  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await api.account.updateProfile({ name: trimmed });
      adoptUser(res.user);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      {error && <Banner tone="error">{error}</Banner>}
      <Field
        label="Your name"
        hint="As you want shops and riders to see it."
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
        maxLength={100}
        required
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          className="flex-1"
          loading={busy}
          // The API wants at least two characters; an unchanged name is not
          // an edit and would only be refused as an empty update.
          disabled={trimmed.length < 2 || trimmed === user.name}
        >
          Save name
        </Button>
        <Button type="button" tone="secondary" className="flex-1" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Change the password while signed in.
 *
 * Two things here are easy to get wrong and expensive when they are:
 *
 *  - **The response carries a new token pair, and it has to be stored at
 *    once.** Changing the password ends every session of the account, this
 *    one's refresh token included. The API hands this device a fresh pair in
 *    the same answer; without storing it, the next token refresh — at most
 *    fifteen minutes away — would present a revoked token, be treated as a
 *    stolen one, and sign the student out of the phone they just changed
 *    their password on.
 *  - **A wrong current password is a 403, and is not a sign-out.** It is a
 *    mistake on a form, shown on the form. Only a 401 means the session is
 *    over, and the client handles that on its own.
 */
export function PasswordForm({ onDone }: { onDone: (message: string) => void }) {
  const { api, client } = useApi();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.auth.changePassword(current, next);
      // First, before anything else can run a request with the old pair.
      await client.setTokens(result);
      onDone(result.message);
    } catch (e) {
      // PASSWORD_INCORRECT, PASSWORD_UNCHANGED, or the length rule: each
      // message says which, and none of them ends the session.
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <p className="text-sm text-[var(--color-ink-soft)]">
        Changing your password signs you out on every other device. You stay signed in here.
      </p>
      {error && <Banner tone="error">{error}</Banner>}
      <Field
        label="Current password"
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
        required
      />
      <Field
        label="New password"
        type="password"
        hint="At least 10 characters. Length matters more than symbols."
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
        minLength={10}
        required
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          className="flex-1"
          loading={busy}
          disabled={current.length === 0 || next.length < 10}
        >
          Change password
        </Button>
        <Button type="button" tone="secondary" className="flex-1" onClick={() => onDone('')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
