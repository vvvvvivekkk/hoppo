'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * Admin console primitives.
 *
 * Denser and plainer than the shop dashboard's. The operator here is trained
 * (U4), working at a desk, often clearing a queue — so the priority is seeing
 * a whole decision at once (FR-ADM-02) and keyboard reach, not large targets.
 */

type Tone = 'primary' | 'secondary' | 'danger' | 'quiet' | 'approve';

const TONE: Record<Tone, string> = {
  primary: 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-strong)]',
  approve: 'bg-[var(--color-ok)] text-white hover:brightness-110',
  secondary: 'bg-white border border-[var(--color-line)] hover:border-[var(--color-ink-faint)]',
  // Destructive actions read as destructive. Suspending a student ends their
  // sessions and releases their task; rejecting a shop is final.
  danger: 'bg-white text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]',
  quiet: 'bg-transparent text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]',
};

export function Button({
  tone = 'primary',
  loading = false,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`tap ${TONE[tone]} rounded-md px-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = rest.id ?? `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {hint && <span className="mb-1 block text-xs text-[var(--color-ink-faint)]">{hint}</span>}
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        className={`tap w-full rounded-md border bg-white px-3 ${
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]'
        }`}
      />
      {error && (
        <span role="alert" className="mt-1 block text-xs font-medium text-[var(--color-danger)]">
          {error}
        </span>
      )}
    </label>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-white">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <div>
            {title && <h2 className="font-bold">{title}</h2>}
            {subtitle && <p className="text-sm text-[var(--color-ink-faint)]">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Pill({ tone, children }: { tone: 'pending' | 'ok' | 'danger' | 'info' | 'plain'; children: ReactNode }) {
  const map = {
    pending: 'bg-[var(--color-pending-bg)] text-[var(--color-pending)]',
    ok: 'bg-[var(--color-ok-bg)] text-[var(--color-ok)]',
    danger: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    info: 'bg-[var(--color-info-bg)] text-[var(--color-info)]',
    plain: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]',
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${map[tone]}`}>
      {children}
    </span>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}) {
  const className =
    tone === 'error'
      ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger)]'
      : tone === 'warn'
        ? 'bg-[var(--color-pending-bg)] text-[var(--color-pending)] border-[var(--color-pending)]'
        : tone === 'success'
          ? 'bg-[var(--color-ok-bg)] text-[var(--color-ok)] border-[var(--color-ok)]'
          : 'bg-[var(--color-info-bg)] text-[var(--color-info)] border-[var(--color-info)]';

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border-l-4 px-3 py-2 text-sm font-medium ${className}`}
    >
      {children}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-14 text-center">
      <p className="font-bold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-ink-faint)]">{body}</p>
    </div>
  );
}

/**
 * A labelled value, for the decision panels.
 *
 * FR-ADM-02 wants everything needed for a decision on one screen, which in
 * practice means a lot of small facts laid out so they can be scanned rather
 * than read.
 */
export function Detail({ label, value, nums }: { label: string; value: ReactNode; nums?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</dt>
      <dd className={`font-medium ${nums ? 'nums' : ''}`}>{value}</dd>
    </div>
  );
}
