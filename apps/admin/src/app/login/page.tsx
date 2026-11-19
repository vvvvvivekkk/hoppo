'use client';

import { useRef, useState } from 'react';
import { Banner, Button, Field, Panel } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/** A-01 */
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
    } catch (e) {
      setError(describeError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-black tracking-tight">Hoppo Admin</p>
          <p className="text-sm text-[var(--color-ink-faint)]">Campus operations</p>
        </div>

        <Panel>
          <form onSubmit={submit} className="space-y-4 p-4">
            {message && <Banner tone="error">{message}</Banner>}

            <Field
              label="Email"
              type="email"
              autoComplete="username"
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

            <Button type="submit" loading={busy} className="w-full">
              Sign in
            </Button>

            {/*
              A-01 in the SRS specifies email, password and TOTP. The second
              factor is not implemented yet, and saying so is better than a
              disabled field implying it exists. An admin account can approve
              shops, suspend students and read identity documents, so this
              belongs before any real deployment.
            */}
            <p className="text-center text-xs text-[var(--color-ink-faint)]">
              Two-factor authentication is not enabled yet on admin accounts.
            </p>
          </form>
        </Panel>
      </div>
    </div>
  );
}
