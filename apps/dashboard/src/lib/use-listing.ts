'use client';

import type { MyShop } from '@hoppo/api-client';
import { useEffect, useState } from 'react';
import { describeError, useApi } from '@/lib/api';

/**
 * The listing this dashboard is operating on.
 *
 * A shop may serve more than one college (FR-SHOP-13), each with its own
 * menu, hours and order queue — so "which listing" is a real question rather
 * than an implementation detail. Phase 1E picks the first active one; a
 * switcher belongs here when multi-college shops actually exist.
 */
export function useListing() {
  const { api } = useApi();
  const [shops, setShops] = useState<MyShop[] | null>(null);
  const [listingId, setListingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { shops: mine } = await api.shops.mine();
        setShops(mine);
        const listings = mine.flatMap((s) => s.listings);
        setListingId((listings.find((l) => l.status === 'ACTIVE') ?? listings[0])?.id ?? null);
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [api]);

  const shop = shops?.find((s) => s.listings.some((l) => l.id === listingId)) ?? null;
  const listing = shop?.listings.find((l) => l.id === listingId) ?? null;

  return { shops, shop, listing, listingId, error, loading: shops === null };
}
