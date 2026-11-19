'use client';

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { MAX_CART_ITEM_QUANTITY } from '@hoppo/shared';

/**
 * The student app's primitives.
 *
 * Same palette as the shop dashboard, different proportions: this is a phone
 * in one hand rather than a tablet on a counter, so targets are 48px rather
 * than 56px and body text is 16px rather than 17px. The 16px is a hard floor,
 * not a preference — see the note in globals.css about iOS Safari zooming the
 * viewport on focus and not zooming back out.
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
      className={`${large ? 'tap-lg text-lg' : 'tap text-base'} ${
        TONE[tone]
      } rounded-xl px-5 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

function fieldId(label: string, given?: string) {
  return given ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function Field({
  label,
  hint,
  error,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const id = fieldId(label, rest.id);

  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block font-semibold text-[var(--color-ink)]">{label}</span>
      {hint && <span className="mb-1 block text-sm text-[var(--color-ink-faint)]">{hint}</span>}
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`tap w-full rounded-xl border-2 bg-white px-4 ${
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]'
        } ${className}`}
      />
      {error && (
        <span
          id={`${id}-error`}
          role="alert"
          className="mt-1 block text-sm font-medium text-[var(--color-danger)]"
        >
          {error}
        </span>
      )}
    </label>
  );
}

export function Select({
  label,
  hint,
  error,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const id = fieldId(label, rest.id);

  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block font-semibold text-[var(--color-ink)]">{label}</span>
      {hint && <span className="mb-1 block text-sm text-[var(--color-ink-faint)]">{hint}</span>}
      <select
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        className={`tap w-full rounded-xl border-2 bg-white px-4 ${
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]'
        }`}
      >
        {children}
      </select>
      {error && (
        <span role="alert" className="mt-1 block text-sm font-medium text-[var(--color-danger)]">
          {error}
        </span>
      )}
    </label>
  );
}

export function TextArea({
  label,
  hint,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = fieldId(label, rest.id);

  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block font-semibold text-[var(--color-ink)]">{label}</span>
      {hint && <span className="mb-1 block text-sm text-[var(--color-ink-faint)]">{hint}</span>}
      <textarea
        {...rest}
        id={id}
        className="w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-4 py-3"
      />
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
  tone?: 'waiting' | 'preparing' | 'ready' | 'danger' | 'plain';
}) {
  const border =
    tone === 'waiting'
      ? 'border-l-8 border-l-[var(--color-waiting)]'
      : tone === 'preparing'
        ? 'border-l-8 border-l-[var(--color-preparing)]'
        : tone === 'ready'
          ? 'border-l-8 border-l-[var(--color-ready)]'
          : tone === 'danger'
            ? 'border-l-8 border-l-[var(--color-danger)]'
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
 * Order status, in the student's words.
 *
 * Deliberately not the same labels the shop dashboard uses for the same
 * values. `PLACED` is "Needs your answer" to a shop and "Waiting for the
 * shop" to a student; `READY` is "Ready for pickup" to a shop and "Rider
 * collecting" to a student, because the student is not the one collecting it.
 * One status, two audiences — sharing the strings would have been shorter and
 * wrong.
 *
 * Every chip carries its own text, so no state is conveyed by colour alone:
 * a phone in direct sun and a colour-blind reader both still read the word.
 */
const STUDENT_STATUS: Record<string, { label: string; className: string }> = {
  PLACED: {
    label: 'Waiting for the shop',
    className: 'bg-[var(--color-waiting-bg)] text-[var(--color-waiting)]',
  },
  SHOP_ACCEPTED: {
    label: 'Accepted',
    className: 'bg-[var(--color-preparing-bg)] text-[var(--color-preparing)]',
  },
  PREPARING: {
    label: 'Being prepared',
    className: 'bg-[var(--color-preparing-bg)] text-[var(--color-preparing)]',
  },
  READY: {
    label: 'Rider collecting',
    className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
  },
  PICKED_UP: {
    label: 'On the way',
    className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
  },
  DELIVERED: {
    label: 'Delivered',
    className: 'bg-[var(--color-ready-bg)] text-[var(--color-ready)]',
  },
  COMPLETED: {
    label: 'Completed',
    className: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]',
  },
  CANCELLED: {
    label: 'Cancelled',
    className: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  },
};

export function Status({ status }: { status: string }) {
  const chip = STUDENT_STATUS[status] ?? {
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

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-[var(--color-line)] bg-white px-6 py-12 text-center">
      <p className="text-lg font-bold text-[var(--color-ink)]">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-[var(--color-ink-faint)]">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-[var(--color-ink-faint)]">
      <span
        aria-hidden
        className="block h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]"
      />
      <span>{label}…</span>
    </div>
  );
}

/**
 * A row of quantity controls.
 *
 * Minus, the count, plus — each a full 48px target. A stepper with 24px
 * buttons is the single most common thing to mis-tap on a phone, and on a
 * cart that means ordering three of something.
 */
export function Stepper({
  quantity,
  onChange,
  // The API refuses a line above this (MAX_CART_ITEM_QUANTITY), so the plus
  // button stops there rather than letting someone build a cart that fails.
  max = MAX_CART_ITEM_QUANTITY,
  label,
}: {
  quantity: number;
  onChange: (next: number) => void;
  max?: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(quantity - 1)}
        aria-label={`Remove one ${label}`}
        className="tap rounded-l-xl border-2 border-[var(--color-line)] bg-white px-4 text-xl font-bold text-[var(--color-ink)]"
      >
        −
      </button>
      <span
        aria-live="polite"
        aria-label={`${quantity} ${label}`}
        className="min-w-11 border-y-2 border-[var(--color-line)] bg-white py-3 text-center font-bold"
      >
        {quantity}
      </span>
      <button
        type="button"
        onClick={() => onChange(quantity + 1)}
        disabled={quantity >= max}
        aria-label={`Add one ${label}`}
        className="tap rounded-r-xl border-2 border-[var(--color-line)] bg-white px-4 text-xl font-bold text-[var(--color-ink)] disabled:opacity-50"
      >
        +
      </button>
    </div>
  );
}
