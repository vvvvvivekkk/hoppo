'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthShell } from '@/components/shell';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/** S-03: sign in with a mobile number or email, plus a password. */
export default function Login() {
  const { login } = useApi();
  const router = useRouter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await login(identifier.trim(), password);
      // Back to the gate, which decides where this account belongs. Routing
      // straight to /shops here would skip the verification check.
      router.replace('/');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">Your mobile number or college email.</p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <Banner tone="error">{error}</Banner>}

        <Field
          label="Mobile or email"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          inputMode="email"
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        <Button type="submit" large loading={busy} className="w-full">
          Sign in
        </Button>
      </form>

      <div className="mt-6 space-y-2 text-center text-sm">
        <Link href="/reset" className="block text-[var(--color-accent)] underline">
          Forgot your password?
        </Link>
        <Link href="/signup" className="block text-[var(--color-ink-soft)]">
          Need an account? <span className="text-[var(--color-accent)] underline">Create one</span>
        </Link>
      </div>
    </AuthShell>
  );
}
