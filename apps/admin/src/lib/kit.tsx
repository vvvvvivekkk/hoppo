'use client';

import { ApiError } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { describeError } from '@/lib/api';
import { Pill } from '@/components/ui';

/**
 * Shared pieces for the admin screens added after the two queues: the guard
 * every action goes through, the words for every enum the API returns, and
 * the two form controls ui.tsx does not have.
 */

/**
 * Run one action at a time.
 *
 * The ref is the guard and `busy` is only how it looks: two clicks handled
 * before React re-renders both read `busy === false`, so state alone lets the
 * second request out. Returns whether the action ran to the end.
 */
export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    try {
      await action();
      return true;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}

/** The same guard, one per row: acting on row B must not free row A. */
export function useKeyedAction() {
  const pending = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    setBusyKeys(new Set(pending.current));
    try {
      await action();
      return true;
    } finally {
      pending.current.delete(key);
      setBusyKeys(new Set(pending.current));
    }
  }, []);

  return { busyKeys, run };
}

/** A refusal in the console's own words where it has some, else the API's. */
export function explain(error: unknown, sentences: Record<string, string> = {}): string {
  if (error instanceof ApiError && sentences[error.code]) return sentences[error.code];
  return describeError(error);
}

/** "TASK_ESCALATED" -> "Task escalated", for open-ended names with no table. */
export function words(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export const ORDER_STATUS: Record<string, string> = {
  PLACED: 'Waiting for the shop',
  SHOP_ACCEPTED: 'Accepted by the shop',
  PREPARING: 'Being prepared',
  READY: 'Ready for pickup',
  PICKED_UP: 'With the rider',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const ORDER_STATUSES = Object.keys(ORDER_STATUS);

export const TASK_STATUS: Record<string, string> = {
  CREATED: 'Not sent to riders yet',
  BROADCASTING: 'Looking for a rider',
  ASSIGNED: 'Rider assigned',
  PICKED_UP: 'Picked up',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  UNFULFILLED: 'No rider found',
  ESCALATED: 'Escalated to an administrator',
  CANCELLED: 'Cancelled',
};

export const TASK_TYPE: Record<string, string> = {
  SHOP_ORDER: 'Shop order',
  PARCEL_PICKUP: 'Parcel pickup',
  PEER_ERRAND: 'Errand',
};

export const PAYMENT_METHOD: Record<string, string> = {
  CASH: 'Cash on delivery',
  WALLET: 'Hoppo wallet',
  ONLINE: 'Online payment',
};

export const PAYMENT_STATUS: Record<string, string> = {
  NOT_REQUIRED: 'Nothing held (cash)',
  PENDING: 'Payment pending',
  HELD: 'Held in the wallet',
  CAPTURED: 'Taken from the wallet',
  REFUNDED: 'Refunded',
  FAILED: 'Payment failed',
};

export const CANCELLED_BY: Record<string, string> = {
  STUDENT: 'the student',
  SHOP: 'the shop',
  ADMIN: 'an administrator',
  SYSTEM: 'the system',
};

export const ACCOUNT_STATUS: Record<string, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Closed',
};

export const VERIFICATION_STATUS: Record<string, string> = {
  UNSUBMITTED: 'Nothing submitted',
  PENDING: 'Waiting for review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
};

export const LISTING_STATUS: Record<string, string> = {
  PENDING_VERIFICATION: 'Awaiting approval',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  REJECTED: 'Rejected',
};

export const label = (table: Record<string, string>, value: string | null | undefined): string =>
  value ? (table[value] ?? words(value)) : '—';

export function OrderStatusPill({ status }: { status: string }) {
  const tone =
    status === 'COMPLETED' || status === 'DELIVERED'
      ? 'ok'
      : status === 'CANCELLED'
        ? 'danger'
        : status === 'PLACED'
          ? 'pending'
          : 'info';
  return <Pill tone={tone}>{label(ORDER_STATUS, status)}</Pill>;
}

export function AccountPill({ status }: { status: string }) {
  return (
    <Pill tone={status === 'ACTIVE' ? 'ok' : status === 'SUSPENDED' ? 'danger' : 'plain'}>
      {label(ACCOUNT_STATUS, status)}
    </Pill>
  );
}

export function ListingPill({ status }: { status: string }) {
  return (
    <Pill
      tone={
        status === 'ACTIVE'
          ? 'ok'
          : status === 'PENDING_VERIFICATION'
            ? 'pending'
            : 'danger'
      }
    >
      {label(LISTING_STATUS, status)}
    </Pill>
  );
}

export const money = (minor: number): string => formatMinor(minor);

/** A timestamp as the administrator's own clock reads it. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function span(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export function Select({
  label: text,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = rest.id ?? `s-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-sm font-semibold">{text}</span>
      <select
        {...rest}
        id={id}
        className="tap w-full rounded-md border border-[var(--color-line)] bg-white px-3"
      >
        {children}
      </select>
    </label>
  );
}

export function TextArea({
  label: text,
  hint,
  error,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string }) {
  const id = rest.id ?? `t-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-sm font-semibold">{text}</span>
      {hint && <span className="mb-1 block text-xs text-[var(--color-ink-faint)]">{hint}</span>}
      <textarea
        rows={3}
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-white px-3 py-2 ${
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

/** Second-level navigation inside a section (Students, Shops, Settings). */
export function Tabs({ current, tabs }: { current: string; tabs: { href: string; label: string }[] }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Section">
      {tabs.map((tab) => (
        <a
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? 'page' : undefined}
          className={`tap flex items-center rounded-md px-3 text-sm font-medium ${
            tab.href === current
              ? 'bg-[var(--color-surface-sunken)] font-bold'
              : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]'
          }`}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export const STUDENT_TABS = [
  { href: '/students', label: 'Verification queue' },
  { href: '/students/find', label: 'All students' },
];

export const SHOP_TABS = [
  { href: '/shops', label: 'Verification queue' },
  { href: '/shops/all', label: 'All shops' },
];

export const SETTINGS_TABS = [
  { href: '/settings', label: 'Serviceable radius' },
  { href: '/settings/config', label: 'Fees and timings' },
  { href: '/settings/delivery-points', label: 'Delivery points' },
];
