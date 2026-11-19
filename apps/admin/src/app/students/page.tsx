'use client';

import type { VerificationQueueItem } from '@hoppo/api-client';
import { ApiError } from '@hoppo/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Detail, Empty, Field, Panel, Pill } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * A-03 and A-04: the student verification queue.
 *
 * FR-ADM-02: "Each queue item shall display all information required for a
 * decision without navigation to another screen." So each row expands in
 * place with everything a reviewer needs — the roll number, the department,
 * whether the mobile and email were verified, how many times this student has
 * been rejected before, and the controlled list of rejection reasons.
 *
 * FR-SVER-05 makes the rejection reason mandatory and drawn from that list,
 * which is why rejection is a two-step interaction rather than one button:
 * there is no way to reject without saying why.
 */
const REJECTION_REASONS = [
  { value: 'ID_CARD_ILLEGIBLE', label: 'ID card is not legible' },
  { value: 'ID_CARD_EXPIRED', label: 'ID card has expired' },
  { value: 'NAME_MISMATCH', label: 'Name does not match the ID card' },
  { value: 'ROLL_NUMBER_MISMATCH', label: 'Roll number does not match' },
  { value: 'NOT_ENROLLED_AT_COLLEGE', label: 'Not enrolled at this college' },
  { value: 'DOCUMENT_INCOMPLETE', label: 'Document is incomplete' },
  { value: 'SUSPECTED_FORGERY', label: 'Suspected forgery' },
  { value: 'DUPLICATE_ACCOUNT', label: 'Duplicate account' },
  { value: 'OTHER', label: 'Something else (explain below)' },
];

const GOVT_ID_LABELS: Record<string, string> = {
  DRIVING_LICENCE: 'Driving licence',
  VOTER_ID: 'Voter ID',
  PASSPORT: 'Passport',
  AADHAAR_MASKED: 'Aadhaar (masked)',
};

export default function StudentsPage() {
  const { api } = useApi();
  const [items, setItems] = useState<VerificationQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Rows with a decision in the air. The ref is the guard and the state is
   * the picture: two clicks handled before React re-renders both see "not
   * busy", and a single busy id is overwritten by a decision on the next row,
   * which re-enables the first row's buttons while its request is still out.
   */
  const pending = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const page = await api.admin.verificationQueue(50);
      setItems(page.items);
      setTotal(page.total ?? page.items.length);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: () => Promise<{ message: string }>) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setBusyIds(new Set(pending.current));
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setNotice(result.message);
      // Remove it locally straight away rather than waiting for the refetch,
      // so a reviewer clearing a queue never acts on a row twice.
      setItems((prev) => prev.filter((i) => i.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      await load();
    } catch (e) {
      // ALREADY_DECIDED is two administrators working one queue, not a fault:
      // say so, and either way reload so the row shows where it stands now.
      // (Reload first: a successful load clears the banner.)
      await load();
      setError(
        e instanceof ApiError && e.code === 'ALREADY_DECIDED'
          ? 'Someone else has already decided that one. The queue below is up to date.'
          : describeError(e),
      );
    } finally {
      pending.current.delete(id);
      setBusyIds(new Set(pending.current));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-black tracking-tight">Student verification</h1>
        <p className="text-sm text-[var(--color-ink-faint)]">
          {total} waiting · oldest first
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Panel>
        {loading ? (
          <Empty title="Loading…" body="Fetching the queue." />
        ) : items.length === 0 ? (
          <Empty
            title="Queue is clear"
            body="Submissions appear here as students upload their ID cards. Students can browse shops while they wait, but cannot order, ride or post."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                busy={busyIds.has(item.id)}
                onApprove={(note) => act(item.id, () => api.admin.approveVerification(item.id, note))}
                onReject={(reason, note) =>
                  act(item.id, () => api.admin.rejectVerification(item.id, reason, note))
                }
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: VerificationQueueItem;
  busy: boolean;
  onApprove: (note?: string) => void;
  onReject: (reason: string, note?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(REJECTION_REASONS[0].value);
  const [note, setNote] = useState('');

  const waitingHours = Math.floor(
    (Date.now() - new Date(item.submittedAt).getTime()) / 3_600_000,
  );

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold">{item.user.name}</p>
            {/* Prior rejections matter to a reviewer: a third submission after
                two rejections deserves a closer look than a first. */}
            {item.priorRejections > 0 && (
              <Pill tone="danger">
                {item.priorRejections} previous rejection
                {item.priorRejections === 1 ? '' : 's'}
              </Pill>
            )}
            {waitingHours >= 24 && <Pill tone="pending">waiting {Math.floor(waitingHours / 24)}d</Pill>}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Detail label="Roll number" value={item.rollNumber} nums />
            <Detail label="Department" value={item.department} />
            <Detail label="Year" value={item.yearOfStudy} nums />
            <Detail
              label="Submitted"
              value={new Date(item.submittedAt).toLocaleString('en-IN')}
            />
            <Detail label="Mobile" value={item.user.mobile} nums />
            <Detail label="Email" value={item.user.email} />
            <Detail
              label="Mobile verified"
              value={
                item.user.mobileVerifiedAt ? <Pill tone="ok">yes</Pill> : <Pill tone="danger">no</Pill>
              }
            />
            <Detail
              label="Government ID"
              value={
                item.govtIdType ? (
                  // Section 11: only the type and the last four characters are
                  // stored, so that is all there is to show. The absence of a
                  // full number here is the design working, not data missing.
                  <span>
                    {GOVT_ID_LABELS[item.govtIdType] ??
                      item.govtIdType.toLowerCase().replace(/_/g, ' ')}{' '}
                    ····{item.govtIdLast4}
                  </span>
                ) : (
                  <span className="text-[var(--color-ink-faint)]">college ID only</span>
                )
              }
            />
          </dl>

          <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
            Document images open through an audited endpoint — every view is recorded against
            your account.
          </p>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-48">
          <Button tone="approve" loading={busy} onClick={() => onApprove()}>
            Approve
          </Button>
          {!rejecting ? (
            <Button tone="danger" disabled={busy} onClick={() => setRejecting(true)}>
              Reject…
            </Button>
          ) : (
            <Button tone="quiet" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {rejecting && (
        <div className="mt-4 space-y-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">
              Reason (the student sees this)
            </span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="tap w-full rounded-md border border-[var(--color-line)] bg-white px-3"
            >
              {REJECTION_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <Field
            label="Note (optional)"
            hint="Anything that helps them fix it and resubmit"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <p className="text-xs text-[var(--color-ink-soft)]">
            They can resubmit, up to three times in any seven-day period.
          </p>

          <Button tone="danger" loading={busy} onClick={() => onReject(reason, note || undefined)}>
            Reject submission
          </Button>
        </div>
      )}
    </li>
  );
}
