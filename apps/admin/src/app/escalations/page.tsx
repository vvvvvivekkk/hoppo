'use client';

import { ApiError, type Escalation, type EscalationOutcome } from '@hoppo/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Detail, Empty, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  PAYMENT_METHOD,
  TASK_STATUS,
  TASK_TYPE,
  TextArea,
  explain,
  label,
  money,
  useAction,
  useKeyedAction,
  when,
} from '@/lib/kit';

/**
 * A-08: escalated tasks (FR-ADM-04).
 *
 * A delivery lands here when the handover code was entered wrongly too many
 * times, or its rider was suspended mid-delivery. Nobody but an administrator
 * can close it, and closing it moves money — so the decision is three steps:
 * choose the outcome, read exactly what it does and say why, then confirm.
 *
 * The outcomes offered for each task are the ones the API lists in
 * `canResolveAs`, not a fixed pair: "not delivered" is not offered for an
 * order paid from the wallet while there is no refund path for it.
 */
const NOTE_MIN = 10;
const NOTE_MAX = 500;

const REFUSALS = {
  ALREADY_RESOLVED:
    'Somebody else resolved this one first. It is shown below as it now stands.',
  NOT_ESCALATED: 'That delivery is not escalated, so there is nothing to resolve.',
  WALLET_REFUND_UNAVAILABLE:
    'This order was paid from the wallet, and "not delivered" cannot be recorded for it yet because the refund cannot be made from here. Nothing was changed.',
  ORDER_NOT_AWAITING_HANDOVER:
    'The order is no longer waiting to be handed over — it has been cancelled or completed some other way — so it cannot be marked delivered. Nothing was changed.',
  CROSS_TENANT_ACCESS: 'That delivery belongs to another college.',
};

const OUTCOME_NAME: Record<EscalationOutcome, string> = {
  DELIVERED: 'It was delivered',
  NOT_DELIVERED: 'It was not delivered',
};

/** What a choice does to the rider's pay and the student's money, in words. */
function consequences(item: Escalation, outcome: EscalationOutcome): string[] {
  const fee = money(item.feeMinor);
  const order = item.order;

  if (outcome === 'DELIVERED') {
    const lines = [
      `The rider, ${item.rider.name}, is paid the delivery fee of ${fee}` +
        (item.reimbursementMinor
          ? `, and is reimbursed ${money(item.reimbursementMinor)} for what they paid on the errand.`
          : '.'),
    ];
    if (order) {
      lines.push(
        order.paymentMethod === 'WALLET'
          ? `The student's ${money(order.totalMinor)}, held in their Hoppo wallet for order ${order.reference}, is taken as payment. They get nothing back.`
          : `Order ${order.reference} was cash on delivery (${money(order.totalMinor)}): Hoppo holds none of the student's money, so nothing is taken from or returned to them here.`,
      );
      lines.push('The order and the delivery are both marked completed.');
    } else {
      lines.push('The delivery is marked completed.');
    }
    return lines;
  }

  const lines = [`The rider, ${item.rider.name}, is paid nothing for this delivery.`];
  if (order) {
    lines.push(
      `Order ${order.reference} is cancelled, recorded as cancelled by an administrator.`,
      order.paymentMethod === 'CASH'
        ? 'It was cash on delivery, so Hoppo holds none of the student’s money and there is nothing to refund.'
        : 'No refund is made from this screen.',
    );
  } else {
    lines.push('The delivery is cancelled. No money is held for it, so there is nothing to refund.');
  }
  return lines;
}

export default function EscalationsPage() {
  const { api } = useApi();
  const [items, setItems] = useState<Escalation[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const more = useAction();
  const rows = useKeyedAction();

  const load = useCallback(async () => {
    try {
      const page = await api.admin.escalations.list(25);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
      setUnavailable(false);
    } catch (e) {
      // A 404 on the list itself is the route not existing on this server,
      // which is a different thing to tell someone than "something broke".
      if (e instanceof ApiError && e.status === 404) setUnavailable(true);
      else setError(explain(e, REFUSALS));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const showMore = () =>
    more.run(async () => {
      if (!nextCursor) return;
      try {
        const page = await api.admin.escalations.list(25, nextCursor);
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (e) {
        setError(explain(e, REFUSALS));
      }
    });

  const resolve = (item: Escalation, outcome: EscalationOutcome, note: string) =>
    rows.run(item.taskId, async () => {
      setError(null);
      setNotice(null);
      try {
        const result = await api.admin.escalations.resolve(item.taskId, outcome, note);
        setNotice(
          `${result.message} Rider paid ${money(result.riderFeeMinor)}; refunded to the student ${money(
            result.refundedMinor,
          )}.`,
        );
        setItems((prev) => (prev ?? []).filter((i) => i.taskId !== item.taskId));
      } catch (e) {
        // Whatever the refusal, show the task as the server has it now. After
        // ALREADY_RESOLVED that is the other administrator's outcome and note.
        let fresh: Escalation | null = null;
        try {
          fresh = await api.admin.escalations.detail(item.taskId);
        } catch {
          fresh = null;
        }
        if (fresh) {
          setItems((prev) => (prev ?? []).map((i) => (i.taskId === item.taskId ? fresh : i)));
        }
        setError(explain(e, REFUSALS));
      }
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-black tracking-tight">Escalated deliveries</h1>
        <p className="text-sm text-[var(--color-ink-faint)]">Longest-waiting first</p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {unavailable ? (
        <Banner tone="warn">
          This server does not have the escalations service yet, so there is no list to show.
          Deliveries that escalate are still recorded and will appear here once it is switched on.
        </Banner>
      ) : (
        <Panel>
          {items === null && !error ? (
            <Empty title="Loading…" body="Fetching escalated deliveries." />
          ) : (items ?? []).length === 0 ? (
            <Empty
              title="Nothing escalated"
              body="A delivery appears here when its handover code has been entered wrongly too many times, or its rider is suspended mid-delivery."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {(items ?? []).map((item) => (
                <Row
                  key={item.taskId}
                  item={item}
                  busy={rows.busyKeys.has(item.taskId)}
                  onResolve={(outcome, note) => void resolve(item, outcome, note)}
                />
              ))}
            </ul>
          )}
          {nextCursor && (
            <div className="border-t border-[var(--color-line)] px-4 py-3">
              <Button tone="secondary" loading={more.busy} onClick={() => void showMore()}>
                Show more
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function Row({
  item,
  busy,
  onResolve,
}: {
  item: Escalation;
  busy: boolean;
  onResolve: (outcome: EscalationOutcome, note: string) => void;
}) {
  const [outcome, setOutcome] = useState<EscalationOutcome | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const trimmed = note.trim();
  const noteProblem =
    trimmed.length < NOTE_MIN
      ? `Say why, in at least ${NOTE_MIN} characters. This note is kept in the audit log.`
      : trimmed.length > NOTE_MAX
        ? `Keep the note under ${NOTE_MAX} characters.`
        : null;

  const open = item.status === 'ESCALATED';
  const walletOnly =
    open && item.order?.paymentMethod === 'WALLET' && !item.canResolveAs.includes('NOT_DELIVERED');

  function cancel() {
    setOutcome(null);
    setConfirming(false);
  }

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-bold">
          {item.order ? `Order ${item.order.reference}` : label(TASK_TYPE, item.type)}
        </p>
        <Pill tone={open ? 'danger' : 'plain'}>{label(TASK_STATUS, item.status)}</Pill>
        <Pill tone="plain">{label(TASK_TYPE, item.type)}</Pill>
        <span className="nums text-xs text-[var(--color-ink-faint)]">escalated {when(item.escalatedAt)}</span>
      </div>

      <p className="mt-2 text-sm">
        <span className="font-semibold">Why it is here:</span> {item.escalationReason}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Detail label="From" value={item.pickupLabel} />
        <Detail label="To" value={item.dropLabel} />
        <Detail label="Rider's fee" value={money(item.feeMinor)} nums />
        <Detail
          label="Wrong codes entered"
          value={`${item.otpAttempts} of ${item.maxOtpAttempts} allowed`}
          nums
        />
        <Detail label="Requested by" value={`${item.requester.name} · ${item.requester.mobile}`} />
        <Detail
          label="Rider"
          value={
            <span>
              {item.rider.name} · {item.rider.mobile}{' '}
              {item.rider.status !== 'ACTIVE' && <Pill tone="danger">{item.rider.status.toLowerCase()}</Pill>}
            </span>
          }
        />
        <Detail label="Picked up" value={when(item.pickedUpAt)} nums />
        {item.order && (
          <Detail
            label="Order"
            value={`${money(item.order.totalMinor)} · ${label(PAYMENT_METHOD, item.order.paymentMethod)}`}
            nums
          />
        )}
      </dl>

      {item.order && (
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          {item.order.shopName}: {item.order.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
        </p>
      )}

      {!open && (
        <div className="mt-3">
          <Banner tone="info">
            Already resolved: {label(TASK_STATUS, item.status).toLowerCase()}
            {item.resolutionNote ? ` — “${item.resolutionNote}”` : '.'}
          </Banner>
        </div>
      )}

      {open && outcome === null && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {item.canResolveAs.includes('DELIVERED') && (
            <Button tone="approve" onClick={() => setOutcome('DELIVERED')}>
              It was delivered…
            </Button>
          )}
          {item.canResolveAs.includes('NOT_DELIVERED') && (
            <Button tone="danger" onClick={() => setOutcome('NOT_DELIVERED')}>
              It was not delivered…
            </Button>
          )}
          {item.canResolveAs.length === 0 && (
            <span className="text-sm text-[var(--color-ink-faint)]">
              The server is not accepting a decision on this one right now.
            </span>
          )}
          {walletOnly && (
            <span className="text-sm text-[var(--color-ink-faint)]">
              “Not delivered” is not available: this order was paid from the wallet, and the refund
              cannot be made from here yet.
            </span>
          )}
        </div>
      )}

      {open && outcome !== null && (
        <div
          role="dialog"
          aria-label={`Resolve: ${OUTCOME_NAME[outcome]}`}
          className={`mt-4 space-y-3 rounded-md border p-3 ${
            outcome === 'DELIVERED'
              ? 'border-[var(--color-ok)] bg-[var(--color-ok-bg)]'
              : 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'
          }`}
        >
          <p className="font-bold">{OUTCOME_NAME[outcome]} — what this does</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {consequences(item, outcome).map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>This cannot be undone from the console.</li>
          </ul>

          {!confirming ? (
            <>
              <TextArea
                label="Reason (required)"
                hint="What you found out, and from whom. Recorded with your name in the audit log."
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                error={note.length > 0 && noteProblem ? noteProblem : undefined}
              />
              <div className="flex flex-wrap gap-2">
                <Button disabled={noteProblem !== null} onClick={() => setConfirming(true)}>
                  Review and confirm
                </Button>
                <Button tone="quiet" onClick={cancel}>
                  Cancel
                </Button>
                {note.length === 0 && (
                  <span className="self-center text-xs text-[var(--color-ink-soft)]">
                    A reason of at least {NOTE_MIN} characters is needed before you can continue.
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="rounded-md bg-white px-3 py-2 text-sm">
                <span className="font-semibold">Your reason:</span> {trimmed}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone={outcome === 'DELIVERED' ? 'approve' : 'danger'}
                  loading={busy}
                  onClick={() => onResolve(outcome, trimmed)}
                >
                  {outcome === 'DELIVERED' ? 'Confirm: delivered' : 'Confirm: not delivered'}
                </Button>
                <Button tone="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  Back
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
