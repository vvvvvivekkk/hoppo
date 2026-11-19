'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { College } from '@hoppo/api-client';
import { AuthShell } from '@/components/shell';
import { Banner, Button, Field, Select } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

type Step = 'mobile' | 'code' | 'details';

/**
 * S-04 to S-06: register.
 *
 * Three steps in one route rather than three routes, because the state in
 * between — a consumed OTP challenge id — is not something to carry in a URL
 * or rebuild after a refresh. FR-AUTH-02 requires the mobile number to be
 * verified before the registration is submitted, and the proof of that is the
 * challenge id, so losing it means starting over.
 *
 * The dev-mode OTP is shown on screen when the API returns it. That only
 * happens when no SMS provider is configured, which is exactly when a
 * developer would otherwise be reading it out of the server log.
 */
export default function Signup() {
  const { api, adoptSession } = useApi();
  const router = useRouter();

  const [step, setStep] = useState<Step>('mobile');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mobile, setMobile] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const [colleges, setColleges] = useState<College[]>([]);
  const [collegeId, setCollegeId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Fetch the college list once the student reaches the step that needs it,
  // not on mount: most people who open this screen are on step one, and the
  // list is a public endpoint worth not hammering.
  useEffect(() => {
    if (step !== 'details' || colleges.length > 0) return;
    void api.auth
      .colleges()
      .then(({ colleges: rows }) => setColleges(rows))
      .catch((e) => setError(describeError(e)));
  }, [step, colleges.length, api]);

  const emailHint = useMemo(() => {
    const college = colleges.find((c) => c.id === collegeId);
    return college?.emailDomain
      ? `Your ${college.emailDomain} address, if you have one.`
      : 'A college address helps verification go faster.';
  }, [colleges, collegeId]);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const res = await api.auth.requestMobileOtp(mobile.trim());
      setChallengeId(res.challengeId);
      setDevCode(res.devCode ?? null);
      setStep('code');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api.auth.verifyMobileOtp(challengeId, code.trim());
      setStep('details');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const tokens = await api.auth.register({
        name: name.trim(),
        mobile: mobile.trim(),
        email: email.trim(),
        password,
        collegeId,
        mobileOtpChallengeId: challengeId,
      });
      // Registration returns a token pair, so there is no second sign-in.
      await adoptSession(tokens);
      router.replace('/');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        Step {step === 'mobile' ? 1 : step === 'code' ? 2 : 3} of 3
      </p>

      {error && (
        <div className="mt-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {step === 'mobile' && (
        <>
          <h1 className="mt-2 text-2xl font-bold">What is your mobile number?</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">
            We send a code to confirm it. This is also how a rider reaches you about a delivery.
          </p>

          <form onSubmit={requestCode} className="mt-6 space-y-4">
            <Field
              label="Mobile number"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="+91 98765 43210"
              inputMode="tel"
              autoComplete="tel"
              required
            />
            <Button type="submit" large loading={busy} className="w-full">
              Send me a code
            </Button>
          </form>
        </>
      )}

      {step === 'code' && (
        <>
          <h1 className="mt-2 text-2xl font-bold">Enter the code</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">Sent to {mobile}.</p>

          {devCode && (
            <div className="mt-4">
              <Banner tone="warn">
                No SMS provider is configured, so the code is shown here:{' '}
                <strong className="font-mono text-lg">{devCode}</strong>
              </Banner>
            </div>
          )}

          <form onSubmit={verifyCode} className="mt-6 space-y-4">
            <Field
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-center font-mono text-2xl tracking-[0.4em]"
              required
            />
            <Button type="submit" large loading={busy} disabled={code.length < 4} className="w-full">
              Confirm
            </Button>
            <Button
              type="button"
              tone="quiet"
              className="w-full"
              onClick={() => {
                setStep('mobile');
                setCode('');
                setError(null);
              }}
            >
              Change the number
            </Button>
          </form>
        </>
      )}

      {step === 'details' && (
        <>
          <h1 className="mt-2 text-2xl font-bold">About you</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">
            Your college decides which shops you see.
          </p>

          <form onSubmit={register} className="mt-6 space-y-4">
            <Field
              label="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
            <Select
              label="College"
              value={collegeId}
              onChange={(e) => setCollegeId(e.target.value)}
              required
            >
              <option value="">Choose your college</option>
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shortName ? `${c.name} (${c.shortName})` : c.name} — {c.city}
                </option>
              ))}
            </Select>
            <Field
              label="Email"
              type="email"
              hint={emailHint}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <Field
              label="Password"
              type="password"
              hint="At least 10 characters. Length matters more than symbols."
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
              disabled={!collegeId || password.length < 10}
              className="w-full"
            >
              Create my account
            </Button>
          </form>
        </>
      )}

      <p className="mt-8 text-center text-sm">
        <Link href="/login" className="text-[var(--color-ink-soft)]">
          Already have an account?{' '}
          <span className="text-[var(--color-accent)] underline">Sign in</span>
        </Link>
      </p>
    </AuthShell>
  );
}
