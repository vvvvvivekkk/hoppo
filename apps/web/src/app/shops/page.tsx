'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { BrowseShop, ItemSearchResult } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, EmptyState, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { VerifyPrompt } from '@/components/verify-prompt';
import { useCart } from '@/lib/cart';

type Sort = 'distance' | 'rating' | 'prepTime';

/**
 * S-10 and S-11: browse and search.
 *
 * Two modes in one screen. An empty search box lists shops; typing searches
 * items across every shop in the college, because "who sells samosas" is the
 * more common question than "what does this shop sell". FR-CAT-06 asks for
 * both.
 *
 * Closed shops are listed, greyed, with the reason — FR-CAT-05 is explicit
 * that they are shown rather than hidden. Hiding them makes a student think
 * their favourite shop has left the platform.
 */
export default function Shops() {
  const { api, user, signedIn } = useApi();
  const { cart, itemCount, subtotalMinor } = useCart();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<Sort>('distance');
  const [openOnly, setOpenOnly] = useState(false);

  const [shops, setShops] = useState<BrowseShop[] | null>(null);
  /**
   * The category chips, taken from the shops that actually exist.
   *
   * `shop.category` is a free-text column, not an enum — a shop owner types it
   * at registration. So a hardcoded list of chips would be a guess, and would
   * either offer a category no shop is in or miss one somebody used.
   * Collected the first time an unfiltered list loads and kept, so selecting
   * a chip does not make the other chips disappear.
   */
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [items, setItems] = useState<ItemSearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Where the next page of shops starts, or null when there are no more. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Bumped whenever the list is replaced, so a late page can tell. */
  const listGeneration = useRef(0);

  // Debounce the search box. Each keystroke otherwise fires a trigram query
  // across every catalog item in the college.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debounced.length >= 2;

  useEffect(() => {
    // Signed out, the Shell is redirecting; the request would only 401.
    if (!signedIn) return;

    let cancelled = false;
    listGeneration.current += 1;
    setLoading(true);
    setError(null);
    setNextCursor(null);

    const request = searching
      ? api.browse.items(debounced).then((res) => {
          if (!cancelled) {
            setItems(res.items);
            setShops(null);
          }
        })
      : api.browse
          .shops({
            category: category || undefined,
            sort,
            openNow: openOnly || undefined,
          })
          .then((res) => {
            if (cancelled) return;
            setShops(res.items);
            setItems(null);
            setNextCursor(res.nextCursor);

            // Only an unfiltered list is a complete picture of the
            // categories; a filtered one only ever contains its own.
            if (!category) {
              setKnownCategories((current) => {
                const next = Array.from(new Set(res.items.map((s) => s.shop.category))).sort();
                return next.length > 0 ? next : current;
              });
            }
          });

    request
      .catch((e) => {
        if (!cancelled) setError(describeError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, signedIn, searching, debounced, category, sort, openOnly]);

  // The list is paged by the API. Without this a college with more shops than
  // one page simply did not show the rest, with nothing to say they existed.
  async function showMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);

    // Which list this page belongs to. If the filters change while it is in
    // the air, the effect above has already replaced the list, and appending
    // to it would mix two different queries on one screen.
    const generation = listGeneration.current;

    try {
      const res = await api.browse.shops({
        category: category || undefined,
        sort,
        openNow: openOnly || undefined,
        cursor: nextCursor,
      });
      if (generation !== listGeneration.current) return;

      setNextCursor(res.nextCursor);
      setShops((current) => {
        if (!current) return current;
        const seen = new Set(current.map((s) => s.listingId));
        return [...current, ...res.items.filter((s) => !seen.has(s.listingId))];
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Shell title={user?.college?.shortName ?? user?.college?.name ?? 'Shops'}>
      {/* Compact here: it sits on the screen a student returns to most, so it
          nudges without taking the first screenful every single visit. */}
      <VerifyPrompt compact />

      <div className="space-y-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for an item or a shop"
          aria-label="Search for an item or a shop"
          className="tap w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-4"
        />

        {!searching && (
          <>
            {/* Horizontal scroll rather than a wrapping grid: on a 360px phone
                six wrapped chips push the first shop below the fold. */}
            {knownCategories.length > 1 && (
              <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1">
                {['', ...knownCategories].map((value) => (
                  <button
                    key={value || 'all'}
                    type="button"
                    onClick={() => setCategory(value)}
                    aria-pressed={category === value}
                    className={`shrink-0 rounded-full border-2 px-4 py-2 text-sm font-semibold capitalize ${
                      category === value
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                        : 'border-[var(--color-line)] bg-white text-[var(--color-ink-soft)]'
                    }`}
                  >
                    {value ? value.toLowerCase().replace(/_/g, ' ') : 'All'}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={openOnly}
                  onChange={(e) => setOpenOnly(e.target.checked)}
                  className="h-5 w-5"
                />
                Open now
              </label>
              <span className="ml-auto flex items-center gap-2">
                <label htmlFor="sort" className="text-[var(--color-ink-faint)]">
                  Sort
                </label>
                <select
                  id="sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as Sort)}
                  className="rounded-lg border-2 border-[var(--color-line)] bg-white px-2 py-1 font-semibold"
                >
                  <option value="distance">Nearest</option>
                  <option value="rating">Best rated</option>
                  <option value="prepTime">Fastest</option>
                </select>
              </span>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {loading && <Spinner label={searching ? 'Searching' : 'Finding shops'} />}

      {!loading && shops && shops.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="No shops to show"
            body={
              openOnly
                ? 'Nothing is open right now. Turn off "Open now" to see everything.'
                : 'No shops at your college match that filter yet.'
            }
          />
        </div>
      )}

      {!loading && shops && shops.length > 0 && (
        <ul className="mt-4 space-y-3">
          {shops.map((shop) => (
            <li key={shop.listingId}>
              <ShopRow shop={shop} />
            </li>
          ))}
        </ul>
      )}

      {!loading && shops && nextCursor && (
        <Button
          tone="secondary"
          className="mt-4 w-full"
          loading={loadingMore}
          onClick={() => void showMore()}
        >
          Show more shops
        </Button>
      )}

      {!loading && items && items.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title={`Nothing matching "${debounced}"`}
            body="Try a shorter word — search looks at item names across every shop at your college."
          />
        </div>
      )}

      {!loading && items && items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <ItemRow item={item} />
            </li>
          ))}
        </ul>
      )}

      {/* The cart bar floats above the tab bar so it is visible from anywhere
          in the browse flow, not only on the shop it belongs to. */}
      {cart && itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-10 mx-auto max-w-2xl px-3">
          <Link href={`/shops/${cart.listingId}`} className="block">
            <div className="flex items-center gap-3 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-white shadow-lg">
              <span className="font-bold">
                {itemCount} {itemCount === 1 ? 'item' : 'items'}
              </span>
              <span className="text-white/80">·</span>
              <span className="truncate">{cart.shopName}</span>
              <span className="ml-auto font-bold">{formatMinor(subtotalMinor)}</span>
            </div>
          </Link>
        </div>
      )}
    </Shell>
  );
}

function ShopRow({ shop }: { shop: BrowseShop }) {
  return (
    <Link href={`/shops/${shop.listingId}`} className="block">
      <Card className={`p-4 ${shop.isOpen ? '' : 'opacity-70'}`}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold">{shop.shop.name}</p>
            <p className="mt-0.5 text-sm text-[var(--color-ink-faint)]">
              {shop.shop.category.toLowerCase()} · {shop.distanceLabel}
              {shop.medianPrepMinutes ? ` · ~${shop.medianPrepMinutes} min prep` : ''}
            </p>
            {shop.averageRating !== null && (
              <p className="mt-1 text-sm font-semibold">
                <span aria-hidden>★</span> {shop.averageRating.toFixed(1)}{' '}
                <span className="font-normal text-[var(--color-ink-faint)]">
                  ({shop.ratingCount})
                </span>
              </p>
            )}
          </div>

          {/* FR-CAT-05: closed is a word, not a grey tint. */}
          {shop.isOpen ? (
            <span className="shrink-0 rounded-full bg-[var(--color-ready-bg)] px-3 py-1 text-xs font-bold text-[var(--color-ready)]">
              Open
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-[var(--color-surface-sunken)] px-3 py-1 text-xs font-bold text-[var(--color-ink-soft)]">
              Closed
            </span>
          )}
        </div>

        {!shop.isOpen && (
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
            {shop.closureNote ??
              (shop.opensInMinutes !== null
                ? `Opens in about ${formatMinutes(shop.opensInMinutes)}.`
                : closedSentence(shop.closedReason))}
          </p>
        )}
      </Card>
    </Link>
  );
}

function ItemRow({ item }: { item: ItemSearchResult }) {
  const router = useRouter();

  return (
    <Card className={`p-4 ${item.shopIsOpen && item.isAvailable ? '' : 'opacity-70'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{item.name}</p>
          <p className="truncate text-sm text-[var(--color-ink-faint)]">
            {item.shop.name} · {item.distanceLabel}
          </p>
          {item.description && (
            <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-soft)]">
              {item.description}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-bold">{formatMinor(item.priceMinor)}</p>
          <Button
            tone="secondary"
            className="mt-2 px-3 text-sm"
            disabled={!item.shopIsOpen || !item.isAvailable}
            onClick={() => router.push(`/shops/${item.listingId}`)}
          >
            {!item.isAvailable ? 'Sold out' : !item.shopIsOpen ? 'Closed' : 'View shop'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * `closedReason` is the shared hours module's enum (see
 * packages/shared/src/hours.ts), not prose. It used to be printed as it
 * came, so a student read "NO_HOURS_SET" under a shop's name.
 */
function closedSentence(reason: string | null): string {
  switch (reason) {
    case 'TEMPORARILY_CLOSED':
      return 'Closed for now — the shop has paused orders.';
    case 'NO_HOURS_SET':
      return 'This shop has not set its opening hours yet, so it cannot take orders.';
    case 'OUTSIDE_HOURS':
      return 'Closed right now — outside its opening hours.';
    default:
      return 'Closed right now.';
  }
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${hours}h ${rest}m`;
}
