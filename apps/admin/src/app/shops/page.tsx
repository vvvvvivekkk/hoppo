'use client';

import type { ShopQueueItem } from '@hoppo/api-client';
import { ApiError } from '@hoppo/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Detail, Empty, Field, Panel, Pill } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * A-05 and A-06: the shop verification queue.
 *
 * FR-SHOP-10 asks that the queue display "the distance computation, the map
 * pin, and all uploaded documents". The distance is the decision here, so it
 * is the largest thing on each row — and it is shown against the limit, not
 * on its own, because 2.4 km means nothing without knowing the radius.
 *
 * Two details carry real weight for a reviewer:
 *
 *  - Whether the owner adjusted the pin. An unadjusted pin came straight from
 *    a geocoder, which for a road name lands in the middle of a road that may
 *    be two kilometres long. At a 3 km threshold, a borderline distance from
 *    an unadjusted pin deserves a second look.
 *  - Whether a food shop has an FSSAI licence, since the platform carrying
 *    prepared food without one exposes both parties.
 */
const REJECTION_REASONS = [
  { value: 'ADDRESS_OUTSIDE_RADIUS', label: 'Address is outside the serviceable radius' },
  { value: 'LICENCE_INVALID', label: 'Licence is invalid or expired' },
  { value: 'DOCUMENT_INCOMPLETE', label: 'Documents are incomplete' },
  { value: 'SUSPECTED_FORGERY', label: 'Suspected forgery' },
  { value: 'OTHER', label: 'Something else (explain below)' },
];

export default function ShopsPage() {
  const { api } = useApi();
  const [items, setItems] = useState<ShopQueueItem[]>([]);
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
      const page = await api.admin.shopQueue(50);
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

  async function act(id: string, action: () => Promise<unknown>, message: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setBusyIds(new Set(pending.current));
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      setItems((prev) => prev.filter((i) => i.listingId !== id));
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
        <h1 className="text-2xl font-black tracking-tight">Shop verification</h1>
        <p className="text-sm text-[var(--color-ink-faint)]">{total} waiting · oldest first</p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Panel>
        {loading ? (
          <Empty title="Loading…" body="Fetching the queue." />
        ) : items.length === 0 ? (
          <Empty
            title="Queue is clear"
            body="Shops appear here after they register. Nothing they submit is visible to students until you approve it."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {items.map((item) => (
              <ShopRow
                key={item.listingId}
                item={item}
                busy={busyIds.has(item.listingId)}
                onApprove={() =>
                  act(
                    item.listingId,
                    () => api.admin.approveShop(item.listingId),
                    `${item.shop.name} approved and visible to students.`,
                  )
                }
                onReject={(reason, note) =>
                  act(
                    item.listingId,
                    () => api.admin.rejectShop(item.listingId, reason, note),
                    `${item.shop.name} rejected.`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ShopRow({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: ShopQueueItem;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string, note?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(REJECTION_REASONS[0].value);
  const [note, setNote] = useState('');

  const sellsFood = item.shop.category === 'FOOD';
  const missingFssai = sellsFood && !item.shop.fssaiLicenceNumber;
  // Within 15% of the limit is close enough that pin accuracy matters.
  const borderline =
    item.withinRadius && item.distanceM > item.radiusM * 0.85;

  const docTypes = new Set(item.shop.documents.map((d) => d.docType));
  const needsPermit = item.shop.locationType === 'ON_CAMPUS';

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        {/* The distance is the decision, so it leads. */}
        <div
          className={`w-full shrink-0 rounded-md border-l-4 px-3 py-2 sm:w-44 ${
            item.withinRadius
              ? 'border-[var(--color-ok)] bg-[var(--color-ok-bg)]'
              : 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'
          }`}
        >
          <p className="nums text-2xl font-black">{item.distanceLabel}</p>
          <p className="nums text-xs text-[var(--color-ink-soft)]">
            limit {(item.radiusM / 1000).toFixed(1)} km
          </p>
          <p
            className={`mt-1 text-xs font-bold ${
              item.withinRadius ? 'text-[var(--color-ok)]' : 'text-[var(--color-danger)]'
            }`}
          >
            {item.withinRadius ? 'within radius' : 'OUTSIDE RADIUS'}
          </p>
        </div>

        <div className="min-w-64 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold">{item.shop.name}</p>
            <Pill tone="plain">{item.shop.category.toLowerCase()}</Pill>
            <Pill tone={item.shop.locationType === 'ON_CAMPUS' ? 'info' : 'plain'}>
              {item.shop.locationType === 'ON_CAMPUS' ? 'inside campus' : 'outside campus'}
            </Pill>
            {!item.pinWasAdjusted && <Pill tone="pending">pin not adjusted</Pill>}
            {borderline && <Pill tone="pending">close to the limit</Pill>}
            {missingFssai && <Pill tone="danger">no FSSAI licence</Pill>}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Detail label="Owner" value={item.shop.ownerName} />
            <Detail label="Mobile" value={item.shop.ownerMobile} nums />
            <Detail label="Email" value={item.shop.ownerEmail} />
            <Detail label="Address" value={`${item.shop.address}, ${item.shop.city}`} />
            <Detail
              label="Coordinates"
              value={`${item.shop.latitude.toFixed(5)}, ${item.shop.longitude.toFixed(5)}`}
              nums
            />
            <Detail
              label="FSSAI"
              value={
                item.shop.fssaiLicenceNumber ? (
                  <span className="nums">{item.shop.fssaiLicenceNumber}</span>
                ) : (
                  <span className="text-[var(--color-ink-faint)]">none</span>
                )
              }
            />
            <Detail
              label="GSTIN"
              value={
                item.shop.gstin ?? <span className="text-[var(--color-ink-faint)]">none</span>
              }
            />
            <Detail
              label="Submitted"
              value={new Date(item.submittedAt).toLocaleString('en-IN')}
            />
            <Detail
              label="Map"
              value={
                // An external map link rather than an embedded map: it is one
                // dependency fewer, and an administrator checking a borderline
                // pin wants street view anyway.
                <a
                  className="font-semibold text-[var(--color-accent)] underline"
                  target="_blank"
                  rel="noreferrer noopener"
                  href={`https://www.google.com/maps/dir/${item.collegePin.latitude},${item.collegePin.longitude}/${item.shopPin.latitude},${item.shopPin.longitude}`}
                >
                  campus → shop
                </a>
              }
            />
          </dl>

          <div className="mt-3">
            <p className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
              Documents on file
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {item.shop.documents.length === 0 && (
                <Pill tone="danger">none uploaded</Pill>
              )}
              {item.shop.documents.map((doc) => (
                <Pill key={doc.id} tone="ok">
                  {doc.docType.toLowerCase().replace(/_/g, ' ')}
                </Pill>
              ))}
              {/* FR-SHOP-07: a shop inside the campus needs the college
                  authority's permit, so its absence is called out rather than
                  left for the reviewer to notice. */}
              {needsPermit && !docTypes.has('CAMPUS_PERMIT') && (
                <Pill tone="danger">campus permit missing</Pill>
              )}
              {!docTypes.has('FRONTAGE_PHOTO') && <Pill tone="danger">frontage photo missing</Pill>}
            </div>
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-44">
          <Button
            tone="approve"
            loading={busy}
            disabled={!item.withinRadius}
            onClick={onApprove}
            title={item.withinRadius ? undefined : 'This shop is outside the serviceable radius'}
          >
            Approve
          </Button>
          {!item.withinRadius && (
            <p className="text-xs text-[var(--color-ink-faint)]">
              Cannot approve while outside the radius. Widen it in Settings, or reject.
            </p>
          )}
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
            <span className="mb-1 block text-sm font-semibold">Reason</span>
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
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <Button tone="danger" loading={busy} onClick={() => onReject(reason, note || undefined)}>
            Reject registration
          </Button>
        </div>
      )}
    </li>
  );
}
