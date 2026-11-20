'use client';

import type { AdminShopDetail } from '@hoppo/api-client';
import { formatDistance } from '@hoppo/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ReasonAction } from '@/components/reason-action';
import { Banner, Button, Detail, Empty, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import { AccountPill, ListingPill, explain, useAction, when, words } from '@/lib/kit';

/**
 * A-06: one shop listing — who runs it, where it is, what is on file, and
 * suspend / reinstate (FR-SHOP-12).
 *
 * Its orders are in the order report filtered to this shop; settlements are
 * not built in this release and are not shown.
 */
const REFUSALS = {
  NOT_FOUND: 'There is no shop listing with that id.',
  CROSS_TENANT_ACCESS: 'That shop belongs to another college.',
  NOT_ACTIVE: 'Only an active shop can be suspended, and this one no longer is. The page below is up to date.',
  NOT_SUSPENDED: 'This shop is not suspended any more. The page below is up to date.',
};

export default function ShopDetailPage() {
  const { api } = useApi();
  const { listingId } = useParams<{ listingId: string }>();
  const [data, setData] = useState<AdminShopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      setData(await api.admin.shopDetail(listingId));
    } catch (e) {
      setError(explain(e, REFUSALS));
    }
  }, [api, listingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (request: () => Promise<{ message: string }>) =>
    action.run(async () => {
      setError(null);
      setNotice(null);
      try {
        const result = await request();
        await load();
        setNotice(result.message);
      } catch (e) {
        await load();
        setError(explain(e, REFUSALS));
      }
    });

  return (
    <div className="space-y-4">
      <Link href="/shops/all" className="text-sm font-semibold text-[var(--color-accent)] underline">
        ← All shops
      </Link>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {!data && !error && <Empty title="Loading…" body="Fetching the shop." />}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight">{data.shop.name}</h1>
            <ListingPill status={data.status} />
            <Pill tone="plain">{words(data.shop.category)}</Pill>
          </div>

          {data.suspension && (
            <Banner tone="warn">
              Suspended{data.suspension.suspendedAt ? ` on ${when(data.suspension.suspendedAt)}` : ''}
              {data.suspension.suspendedBy ? ` by ${data.suspension.suspendedBy.name}` : ''}
              {data.suspension.reason ? `: ${data.suspension.reason}` : '. No reason was recorded.'}
            </Banner>
          )}
          {data.rejection && (
            <Banner tone="warn">
              Registration rejected{data.rejection.reason ? `: ${words(data.rejection.reason).toLowerCase()}` : ''}.
              {data.rejection.note ? ` ${data.rejection.note}` : ''}
            </Banner>
          )}
          {data.flaggedForRadiusReviewAt && (
            <Banner tone="warn">
              Outside the current serviceable radius since {when(data.flaggedForRadiusReviewAt)}. It
              stays active until you decide.
            </Banner>
          )}

          <Panel title="Listing">
            <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail
                label="Distance from campus"
                value={`${data.distanceLabel} (limit ${formatDistance(data.radiusM)})`}
                nums
              />
              <Detail label="Within the radius" value={data.withinRadius ? 'Yes' : 'No'} />
              <Detail label="Registered" value={when(data.submittedAt)} nums />
              <Detail
                label="Approved"
                value={
                  data.approval
                    ? `${when(data.approval.approvedAt)}${data.approval.approvedBy ? ` by ${data.approval.approvedBy.name}` : ''}`
                    : 'Not approved'
                }
              />
              <Detail label="Items on the menu" value={data.counts.catalogItems} nums />
              <Detail label="Orders in all" value={data.counts.orders} nums />
              <Detail label="Orders in progress now" value={data.counts.inFlightOrders} nums />
              <Detail
                label="Rating"
                value={
                  data.rating.average === null
                    ? 'No ratings yet'
                    : `${data.rating.average.toFixed(1)} from ${data.rating.count} rating${data.rating.count === 1 ? '' : 's'}`
                }
                nums
              />
            </dl>
            <p className="border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <Link
                href={`/orders`}
                className="font-semibold text-[var(--color-accent)] underline"
              >
                Open the order report
              </Link>{' '}
              and choose this shop in the Shop filter to see its orders.
            </p>
          </Panel>

          <Panel title="Shop and owner">
            <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Owner" value={data.shop.ownerName} />
              <Detail label="Owner's mobile" value={data.shop.ownerMobile} nums />
              <Detail label="Owner's email" value={data.shop.ownerEmail ?? 'Not given'} />
              <Detail
                label="Where"
                value={data.shop.locationType === 'ON_CAMPUS' ? 'Inside campus' : 'Outside campus'}
              />
              <Detail
                label="Address"
                value={`${data.shop.address}, ${data.shop.city}, ${data.shop.state} ${data.shop.pincode ?? ''}`}
              />
              <Detail
                label="Map pin"
                value={`${data.shop.latitude.toFixed(5)}, ${data.shop.longitude.toFixed(5)}${
                  data.shop.pinAdjusted ? '' : ' (not adjusted by the owner)'
                }`}
                nums
              />
              <Detail label="FSSAI licence" value={data.shop.fssaiLicenceNumber ?? 'None'} nums />
              <Detail label="GSTIN" value={data.shop.gstin ?? 'None'} nums />
            </dl>
          </Panel>

          <Panel title="Suspend or reinstate">
            <div className="space-y-3 p-4">
              {data.status === 'ACTIVE' && (
                <ReasonAction
                  trigger="Suspend this shop…"
                  title={`Suspend ${data.shop.name}`}
                  effects={
                    <ul className="list-disc space-y-1 pl-5">
                      <li>It is hidden from students at once and can take no new orders.</li>
                      <li>
                        {data.counts.inFlightOrders > 0
                          ? `${data.counts.inFlightOrders} order${data.counts.inFlightOrders === 1 ? ' is' : 's are'} in progress right now. ${data.counts.inFlightOrders === 1 ? 'It is' : 'They are'} not cancelled: the shop can still finish and hand over.`
                          : 'No order is in progress right now. Any that were would be allowed to finish.'}
                      </li>
                      <li>You can reinstate it from this page.</li>
                    </ul>
                  }
                  confirmLabel="Confirm: suspend"
                  busy={action.busy}
                  onConfirm={(reason) => void change(() => api.admin.suspendShop(listingId, reason))}
                />
              )}
              {data.status === 'SUSPENDED' && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    tone="approve"
                    loading={action.busy}
                    onClick={() => void change(() => api.admin.reinstateShop(listingId))}
                  >
                    Reinstate this shop
                  </Button>
                  <span className="text-sm text-[var(--color-ink-faint)]">
                    It becomes visible to students again and can take orders.
                  </span>
                </div>
              )}
              {data.status === 'PENDING_VERIFICATION' && (
                <p className="text-sm text-[var(--color-ink-faint)]">
                  This shop has not been approved yet. Approve or reject it from the{' '}
                  <Link href="/shops" className="font-semibold text-[var(--color-accent)] underline">
                    verification queue
                  </Link>
                  .
                </p>
              )}
              {data.status === 'REJECTED' && (
                <p className="text-sm text-[var(--color-ink-faint)]">
                  This registration was rejected, so there is nothing to suspend or reinstate.
                </p>
              )}
            </div>
          </Panel>

          <Panel title="People with access">
            {data.staff.length === 0 ? (
              <Empty title="Nobody" body="No account is attached to this shop." />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {data.staff.map((person) => (
                  <li key={person.userId} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <span className="font-semibold">{person.name}</span>
                    <Pill tone="plain">{person.isOwner ? 'owner' : 'staff'}</Pill>
                    <AccountPill status={person.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Documents on file" subtitle="What the shop uploaded. The files themselves cannot be opened from this console yet.">
            {data.documents.length === 0 ? (
              <Empty title="None uploaded" body="This shop has no documents on file." />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {data.documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                    <span className="font-semibold">{words(doc.docType)}</span>
                    <span className="text-[var(--color-ink-faint)]">{doc.fileName ?? 'no file name recorded'}</span>
                    <span className="nums text-[var(--color-ink-faint)]">uploaded {when(doc.uploadedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
