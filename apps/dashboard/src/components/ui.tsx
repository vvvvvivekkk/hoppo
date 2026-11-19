'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * The dashboard's primitives.
 *
 * Deliberately few and deliberately plain. This is a counter tablet operated
 * by someone mid-order (U3 in the SRS: "often busy, limited technical skill"),
 * so the interface is large text, large targets, and no cleverness.
 */

type ButtonTone = 'primary' | 'secondary' | 'danger' | 'quiet';

const TONE: Record<ButtonTone, string> = {
  primary:
    'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-strong)] disabled:bg-[var(--color-ink-faint)]',
  secondary:
    'bg-white text-[var(--color-ink)] border-2 border-[var(--color-line)] hover:border-[var(--color-ink-faint)]',
  danger:
    'bg-white text-[var(--color-danger)] border-2 border-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]',
  quiet: 'bg-transparent text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]',
};

export function Button({
  tone = 'primary',
  large = false,
  loading = false,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  large?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`${large ? 'tap-lg text-xl' : 'tap text-lg'} ${
        TONE[tone]
      } rounded-xl px-6 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
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
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const id = rest.id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block font-semibold text-[var(--color-ink)]">{label}</span>
      {hint && <span className="mb-1 block text-sm text-[var(--color-ink-faint)]">{hint}</span>}
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`tap w-full rounded-xl border-2 bg-white px-4 text-lg ${
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]'
        }`}
      />
      {/* role=alert so a screen reader announces the problem rather than
          leaving it to be noticed visually. */}
      {error && (
        <span id={`${id}-error`} role="alert" className="mt-1 block text-sm font-medium text-[var(--color-danger)]">
          {error}
        </span>
      )}
    </label>
  );
}

export function Card({
  children,
  className = '',
  tone,
}: {
  children: ReactNode;
  className?: string;
  tone?: 'waiting' | 'preparing' | 'ready' | 'plain';
}) {
  const border =
    tone === 'waiting'
      ? 'border-l-8 border-l-[var(--color-waiting)]'
      : tone === 'preparing'
        ? 'border-l-8 border-l-[var(--color-preparing)]'
        : tone === 'ready'
          ? 'border-l-8 border-l-[var(--color-ready)]'
          : '';

  return (
    <div
      className={`rounded-2xl border border-[var(--color-line)] bg-white shadow-sm ${border} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A status chip that always carries its own text.
 *
 * NFR-U-04 is about contrast, but the related rule this follows is that no
 * state is conveyed by colour alone — a washed-out tablet screen in window
 * light, or a colour-blind operator, both still read the word.
 */
export function Status({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    PLACED: {
      label: 'Needs your answer',
      className: 'bg-[var(--color-waiting-bg)] text-[var(--color-waiting)]',
    },
    SHOP_ACCEPTED: {
      label: 'Accepted',
      className: 'bg-[var(--color-preparing-bg)] text-[var(--color-preparing)]',
    },
    PREPARING: {
      label: 'Preparing',
      className: 'bg-[var(--color-preparing-bg)] text-[var(--color-preparing)]',
    },
    READY: {
      label: 'Ready for pickup',
      className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
    },
    PICKED_UP: {
      label: 'With the rider',
      className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
    },
    COMPLETED: {
      label: 'Delivered',
      className: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]',
    },
    CANCELLED: {
      label: 'Cancelled',
      className: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    PENDING_VERIFICATION: {
      label: 'Awaiting approval',
      className: 'bg-[var(--color-waiting-bg)] text-[var(--color-waiting)]',
    },
    ACTIVE: {
      label: 'Active',
      className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
    },
    SUSPENDED: {
      label: 'Suspended',
      className: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
    REJECTED: {
      label: 'Rejected',
      className: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
    },
  };

  const chip = map[status] ?? {
    label: status.toLowerCase().replace(/_/g, ' '),
    className: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]',
  };

  return (
    <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${chip.className}`}>
      {chip.label}
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
        ? 'bg-[var(--color-waiting-bg)] text-[var(--color-waiting)] border-[var(--color-waiting)]'
        : tone === 'success'
          ? 'bg-[var(--color-ready-bg)] text-[var(--color-ready)] border-[var(--color-ready)]'
          : 'bg-[var(--color-preparing-bg)] text-[var(--color-preparing)] border-[var(--color-preparing)]';

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border-l-4 px-4 py-3 font-medium ${className}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-[var(--color-line)] bg-white px-6 py-16 text-center">
      <p className="text-xl font-bold text-[var(--color-ink)]">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[var(--color-ink-faint)]">{body}</p>
    </div>
  );
}
