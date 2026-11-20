'use client';

import type { AdminShopListItem, AdminShopListQuery, ShopListingStatus } from '@hoppo/api-client';
import { formatDistance } from '@hoppo/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Empty, Field, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  LISTING_STATUS,
  ListingPill,
  SHOP_TABS,
  Select,
  Tabs,
  explain,
  useAction,
  when,
  words,
} from '@/lib/kit';

/** A-06, finding the shop: every listing of the college, whatever its state. */
interface Filters {
  q: string;
  status: '' | ShopListingStatus;
}

const NO_FILTERS: Filters = { q: '', status: '' };
const toQuery = (f: Filters): AdminShopListQuery => ({
  q: f.q.trim() || undefined,
  status: f.status || undefined,
});

export default function AllShopsPage() {
  const { api } = useApi();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<AdminShopListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useAction();
  const more = useAction();

  const read = useCallback(
    (filters: Filters) =>
      load.run(async () => {
        try {
          const page = await api.admin.listShops({ ...toQuery(filters), limit: 25 });
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setApplied(filters);
          setError(null);
        } catch (e) {
          setError(explain(e));
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  useEffect(() => {
    void read(NO_FILTERS);
  }, [read]);

  const showMore = () =>
    more.run(async () => {
      if (!nextCursor) return;
      try {
        const page = await api.admin.listShops({ ...toQuery(applied), limit: 25, cursor: nextCursor });
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (e) {
        setError(explain(e));
      }
    });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Shops</h1>
      <Tabs current="/shops/all" tabs={SHOP_TABS} />

      <Panel title="Find a shop">
        <form
          className="grid gap-3 p-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void read(draft);
          }}
        >
          <Field label="Shop name" value={draft.q} onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))} />
          <Select
            label="Status"
            value={draft.status}
            onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value as Filters['status'] }))}
          >
            <option value="">Any</option>
            {Object.entries(LISTING_STATUS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <div className="flex items-end">
            <Button type="submit" loading={load.busy}>
              Search
            </Button>
          </div>
        </form>
      </Panel>

      {error && <Banner tone="error">{error}</Banner>}

      <Panel>
        {items === null ? (
          <Empty title="Loading…" body="Fetching shops." />
        ) : items.length === 0 ? (
          <Empty title="No shop matches" body="Try part of the name, or clear the status filter." />
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-line)] text-sm">
              {items.map((item) => (
                <li key={item.listingId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Link
                    href={`/shops/${item.listingId}`}
                    className="min-w-56 font-bold text-[var(--color-accent)] underline"
                  >
                    {item.shop.name}
                  </Link>
                  <ListingPill status={item.status} />
                  <Pill tone="plain">{words(item.shop.category)}</Pill>
                  <span className="nums">{formatDistance(item.distanceM)} from campus</span>
                  <span>{item.shop.locationType === 'ON_CAMPUS' ? 'inside campus' : 'outside campus'}</span>
                  {item.flaggedForRadiusReview && <Pill tone="pending">outside the current radius</Pill>}
                  <span className="nums text-[var(--color-ink-faint)]">registered {when(item.submittedAt)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="text-[var(--color-ink-faint)]">
                Showing {items.length}
                {nextCursor ? '' : ' — that is every shop that matches'}
              </span>
              {nextCursor && (
                <Button tone="secondary" loading={more.busy} onClick={() => void showMore()}>
                  Show more
                </Button>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
