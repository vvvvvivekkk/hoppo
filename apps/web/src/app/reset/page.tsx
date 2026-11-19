'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthShell } from '@/components/shell';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * Password reset by mobile OTP.
 *
 * The API deliberately answers the first step the same way whether or not the
 * number is registered, so this screen moves to the code step either way. It
 * would be friendlier to say "no account with that number" and it would also
 * tell anyone with a list of numbers which ones are students here.
 */
export default function Reset() {
  const { api } = useApi();
  const router = useRouter();

  const [stage, setStage] = useState<'request' | 'confirm' | 'done'>('request');
  const [mobile, setMobile] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const res = await api.auth.requestPasswordReset(mobile.trim());
      setChallengeId(res.challengeId ?? '');
      setDevCode(res.devCode ?? null);
      setStage('confirm');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api.auth.resetPassword(challengeId, code.trim(), password);
      setStage('done');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-bold">Reset your password</h1>

      {error && (
        <div className="mt-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {stage === 'request' && (
        <form onSubmit={request} className="mt-6 space-y-4">
          <Field
            label="Mobile number"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            inputMode="tel"
            autoComplete="tel"
            required
          />
          <Button type="submit" large loading={busy} className="w-full">
            Send me a code
          </Button>
        </form>
      )}

      {stage === 'confirm' && (
        <>
          <p className="mt-2 text-[var(--color-ink-soft)]">
            If {mobile} has an account, a code is on its way.
          </p>

          {devCode && (
            <div className="mt-4">
              <Banner tone="warn">
                No SMS provider is configured, so the code is shown here:{' '}
                <strong className="font-mono text-lg">{devCode}</strong>
              </Banner>
            </div>
          )}

          <form onSubmit={confirm} className="mt-6 space-y-4">
            <Field
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-center font-mono text-2xl tracking-[0.4em]"
              required
            />
            <Field
              label="New password"
              type="password"
              hint="At least 10 characters."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
            <Button
              type="submit"
              large
              loading={busy}
              disabled={password.length < 10}
              className="w-full"
            >
              Set the new password
            </Button>
          </form>
        </>
      )}

      {stage === 'done' && (
        <>
          <div className="mt-4">
            <Banner tone="success">
              Your password is changed. Every other device has been signed out.
            </Banner>
          </div>
          <Button large className="mt-6 w-full" onClick={() => router.replace('/login')}>
            Sign in
          </Button>
        </>
      )}

      <p className="mt-8 text-center text-sm">
        <Link href="/login" className="text-[var(--color-accent)] underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
