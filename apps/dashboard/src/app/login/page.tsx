'use client';

import { useRef, useState } from 'react';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/** D-01 */
export default function LoginPage() {
  const { login, notice } = useApi();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A second submit in the same tick (Enter and a tap landing together) would
  // otherwise send two logins before `busy` has rendered the button disabled.
  const submitting = useRef(false);

  // Why they are here, when they did not choose to be: suspended, signed out,
  // or holding an account that belongs in a different app.
  const message = error ?? notice;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);

    try {
      await login(identifier.trim(), password);
      // Navigation is handled by the shell once the user loads, so that the
      // redirect and the auth state can never disagree.
    } catch (e) {
      setError(describeError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-3xl font-black tracking-tight">Hoppo</p>
          <p className="mt-1 text-[var(--color-ink-faint)]">Shop dashboard</p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-5 rounded-2xl border border-[var(--color-line)] bg-white p-6 shadow-sm"
        >
          {message && <Banner tone="error">{message}</Banner>}

          <Field
            label="Mobile number or email"
            // autoComplete so a tablet's keychain can fill it, which matters
            // when the same device is used every day.
            autoComplete="username"
            inputMode="email"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />

          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button type="submit" large loading={busy} className="w-full">
            Sign in
          </Button>

          <p className="text-center text-sm text-[var(--color-ink-faint)]">
            New shop?{' '}
            <a className="font-semibold text-[var(--color-accent)] underline" href="/register">
              Register here
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
