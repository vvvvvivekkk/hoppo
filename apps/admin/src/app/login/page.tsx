'use client';

import { useState } from 'react';
import { Banner, Button, Field, Panel } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/** A-01 */
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
    } catch (e) {
      setError(describeError(e));
    } finally {
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
            {error && <Banner tone="error">{error}</Banner>}

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
