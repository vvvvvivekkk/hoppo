'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { CatalogItem, ShopDetail } from '@hoppo/api-client';
import { formatMinor } from '@hoppo/shared';
import { Shell } from '@/components/shell';
import { Banner, Button, Card, EmptyState, Spinner, Stepper } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useCart } from '@/lib/cart';

/**
 * S-12 and S-13: one shop, its catalog, and the cart.
 *
 * The cart lives at the bottom of the screen rather than on a separate page.
 * A student adding a third samosa should not have to navigate to see what
 * that costs, and a cart page that is one tap away is a cart page nobody
 * opens until checkout, by which point the total is a surprise.
 */
export default function Shop() {
  const params = useParams<{ listingId: string }>();
  const listingId = params.listingId;

  const { api, signedIn } = useApi();
  const router = useRouter();
  const cart = useCart();

  const [shop, setShop] = useState<ShopDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchPrompt, setSwitchPrompt] = useState<{
    item: CatalogItem;
    fromShop: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setShop(await api.browse.shop(listingId));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api, listingId]);

  useEffect(() => {
    // Signed out, the Shell is redirecting; the request would only 401.
    if (signedIn) void load();
  }, [load, signedIn]);

  const lines = cart.linesFor(listingId);
  const lineTotal = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);

  function addItem(item: CatalogItem) {
    // One cart, one shop — see the note in cart.tsx. Ask before discarding
    // a cart that belongs to a different shop.
    if (cart.cart && cart.cart.listingId !== listingId) {
      setSwitchPrompt({ item, fromShop: cart.cart.shopName });
      return;
    }
    cart.add(listingId, shop?.shop.name ?? 'Shop', {
      catalogItemId: item.id,
      name: item.name,
      unitPriceMinor: item.priceMinor,
    });
  }

  if (loading) {
    return (
      <Shell back="/shops" title="Shop">
        <Spinner />
      </Shell>
    );
  }

  if (!shop) {
    return (
      <Shell back="/shops" title="Shop">
        <Banner tone="error">{error ?? 'Could not load this shop.'}</Banner>
      </Shell>
    );
  }

  // Items the shop filed under no category. Optional-chained because an API
  // build from before the field existed does not send it.
  const uncategorised = shop.uncategorised ?? [];
  const categorised = shop.categories.filter((category) => category.items.length > 0);
  const allItems = [...shop.categories.flatMap((c) => c.items), ...uncategorised];

  return (
    <Shell back="/shops" title={shop.shop.name}>
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--color-ink-faint)]">
              {shop.shop.category.toLowerCase()} · {shop.distanceLabel}
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{shop.shop.address}</p>
            {shop.averageRating !== null && (
              <p className="mt-1 text-sm font-semibold">
                <span aria-hidden>★</span> {shop.averageRating.toFixed(1)}{' '}
                <span className="font-normal text-[var(--color-ink-faint)]">
                  ({shop.ratingCount} ratings)
                </span>
              </p>
            )}
          </div>
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
      </Card>

      {!shop.isOpen && (
        <div className="mt-3">
          <Banner tone="warn">
            {shop.closureNote ??
              (shop.opensInMinutes !== null
                ? `Closed now — opens in about ${shop.opensInMinutes} minutes. You can look, but not order yet.`
                : 'Closed right now. You can look, but not order yet.')}
          </Banner>
        </div>
      )}

      {switchPrompt && (
        <div className="mt-3">
          <Card tone="waiting" className="p-4">
            <p className="font-semibold">Your cart has items from {switchPrompt.fromShop}.</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              An order goes to one shop, so adding this will empty that cart.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  cart.clear();
                  cart.add(listingId, shop.shop.name, {
                    catalogItemId: switchPrompt.item.id,
                    name: switchPrompt.item.name,
                    unitPriceMinor: switchPrompt.item.priceMinor,
                  });
                  setSwitchPrompt(null);
                }}
              >
                Start a new cart
              </Button>
              <Button tone="secondary" className="flex-1" onClick={() => setSwitchPrompt(null)}>
                Keep the old one
              </Button>
            </div>
          </Card>
        </div>
      )}

      {allItems.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="Nothing on the menu yet"
            body="This shop has not added any items. Try another one."
            action={
              <Link href="/shops">
                <Button tone="secondary">Back to shops</Button>
              </Link>
            }
          />
        </div>
      )}

      {categorised.map((category) => (
        <section key={category.id} className="mt-6">
          <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">{category.name}</h2>
          <ul className="space-y-3">
            {category.items.map((item) => (
              <li key={item.id}>
                <ItemCard
                  item={item}
                  shopOpen={shop.isOpen}
                  quantity={cart.quantityOf(listingId, item.id)}
                  onAdd={() => addItem(item)}
                  onChange={(next) => cart.setQuantity(item.id, next)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* A shop that never set categories up has its whole menu here. It
          used to be dropped, and the shop looked empty. "More" only when
          there are categories above it to be more than; on its own the
          items need no heading at all. */}
      {uncategorised.length > 0 && (
        <section className="mt-6">
          {categorised.length > 0 && (
            <h2 className="mb-2 font-bold text-[var(--color-ink-soft)]">More</h2>
          )}
          <ul className="space-y-3">
            {uncategorised.map((item) => (
              <li key={item.id}>
                <ItemCard
                  item={item}
                  shopOpen={shop.isOpen}
                  quantity={cart.quantityOf(listingId, item.id)}
                  onAdd={() => addItem(item)}
                  onChange={(next) => cart.setQuantity(item.id, next)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-10 mx-auto max-w-2xl px-3">
          <button
            type="button"
            onClick={() => router.push('/checkout')}
            disabled={!shop.isOpen}
            className="tap-lg flex w-full items-center gap-3 rounded-xl bg-[var(--color-accent)] px-4 font-bold text-white shadow-lg disabled:bg-[var(--color-ink-faint)]"
          >
            <span>
              {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
            </span>
            <span className="text-white/70">·</span>
            <span>{formatMinor(lineTotal)}</span>
            <span className="ml-auto">{shop.isOpen ? 'Checkout →' : 'Shop is closed'}</span>
          </button>
          <p className="mt-1 text-center text-xs text-[var(--color-ink-faint)]">
            Delivery and platform fees are added at checkout.
          </p>
        </div>
      )}
    </Shell>
  );
}

function ItemCard({
  item,
  shopOpen,
  quantity,
  onAdd,
  onChange,
}: {
  item: CatalogItem;
  shopOpen: boolean;
  quantity: number;
  onAdd: () => void;
  onChange: (next: number) => void;
}) {
  const orderable = shopOpen && item.isAvailable;

  return (
    <Card className={`p-4 ${orderable ? '' : 'opacity-70'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-bold">{item.name}</p>
          {item.description && (
            <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{item.description}</p>
          )}
          <p className="mt-1 font-semibold">
            {formatMinor(item.priceMinor)}
            {item.prepMinutes > 0 && (
              <span className="ml-2 font-normal text-sm text-[var(--color-ink-faint)]">
                {item.prepMinutes} min
              </span>
            )}
          </p>
          {!item.isAvailable && (
            <p className="mt-1 text-sm font-semibold text-[var(--color-ink-faint)]">
              Not available today
            </p>
          )}
        </div>

        <div className="shrink-0">
          {quantity === 0 ? (
            <Button tone="secondary" disabled={!orderable} onClick={onAdd} className="px-4">
              Add
            </Button>
          ) : (
            <Stepper quantity={quantity} onChange={onChange} label={item.name} />
          )}
        </div>
      </div>
    </Card>
  );
}
