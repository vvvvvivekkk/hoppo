'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { TextArea } from '@/lib/kit';

/**
 * An action that needs a written reason and a second look before it happens:
 * suspending a student or a shop, deactivating a college or an administrator.
 *
 * Three states, in place: the button; the reason and what the action does;
 * a confirm step that repeats the reason back. The caller's `onConfirm` is
 * what actually sends the request, and `busy` is its guard's state.
 */
export function ReasonAction({
  trigger,
  title,
  effects,
  confirmLabel,
  minLength = 5,
  maxLength = 500,
  busy,
  onConfirm,
}: {
  trigger: string;
  title: string;
  effects: ReactNode;
  confirmLabel: string;
  minLength?: number;
  maxLength?: number;
  busy: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const problem =
    trimmed.length < minLength
      ? `Give a reason of at least ${minLength} characters.`
      : trimmed.length > maxLength
        ? `Keep the reason under ${maxLength} characters.`
        : null;

  if (!open) {
    return (
      <Button tone="danger" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={title}
      className="space-y-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3"
    >
      <p className="font-bold">{title}</p>
      <div className="text-sm">{effects}</div>

      {!confirming ? (
        <>
          <TextArea
            label="Reason (required)"
            hint="Recorded with your name in the audit log."
            value={reason}
            maxLength={maxLength}
            onChange={(e) => setReason(e.target.value)}
            error={reason.length > 0 && problem ? problem : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={problem !== null} onClick={() => setConfirming(true)}>
              Review and confirm
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setOpen(false);
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="rounded-md bg-white px-3 py-2 text-sm">
            <span className="font-semibold">Your reason:</span> {trimmed}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button tone="danger" loading={busy} onClick={() => onConfirm(trimmed)}>
              {confirmLabel}
            </Button>
            <Button tone="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
