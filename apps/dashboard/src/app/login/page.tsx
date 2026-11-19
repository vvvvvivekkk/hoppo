'use client';

import { useState } from 'react';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/** D-01 */
export default function LoginPage() {
  const { login } = useApi();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await login(identifier.trim(), password);
      // Navigation is handled by the shell once the user loads, so that the
      // redirect and the auth state can never disagree.
    } catch (e) {
      setError(describeError(e));
    } finally {
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
          {error && <Banner tone="error">{error}</Banner>}

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
