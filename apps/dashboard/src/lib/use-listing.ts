'use client';

import type { MyShop } from '@hoppo/api-client';
import { useCallback, useEffect, useState } from 'react';
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

  const reload = useCallback(async () => {
    try {
      const { shops: mine } = await api.shops.mine();
      setShops(mine);
      const listings = mine.flatMap((s) => s.listings);
      setListingId(
        (prev) =>
          listings.find((l) => l.id === prev)?.id ??
          (listings.find((l) => l.status === 'ACTIVE') ?? listings[0])?.id ??
          null,
      );
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shop = shops?.find((s) => s.listings.some((l) => l.id === listingId)) ?? null;
  const listing = shop?.listings.find((l) => l.id === listingId) ?? null;

  // An owner waiting on approval leaves the tab open. /shops/mine is the one
  // shop endpoint the API serves before approval, so it is what gets re-read;
  // the screen then unlocks by itself when the administrator approves.
  const awaitingDecision = listing?.status === 'PENDING_VERIFICATION';
  useEffect(() => {
    if (!awaitingDecision) return;
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [awaitingDecision, reload]);

  return {
    shops,
    shop,
    listing,
    listingId,
    // Only an error while there is nothing to show. A failed re-read with a
    // listing already on screen is not a reason to replace the page.
    error: shops === null ? error : null,
    // Loading means "no answer yet" — a failed first read is an answer, and
    // leaving it as loading is what used to strand the page on "Loading…".
    loading: shops === null && error === null,
    reload,
  };
}
