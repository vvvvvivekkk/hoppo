'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MAX_CART_ITEM_QUANTITY } from '@hoppo/shared';
import { useApi } from './api';

export interface CartLine {
  catalogItemId: string;
  name: string;
  /**
   * The price when the item went into the cart, in paise.
   *
   * Display only. The API's quote endpoint re-reads every price at checkout
   * and is the only authority on what the order costs — this copy exists so
   * the cart can show a running total without a round trip per tap. When the
   * two disagree, the checkout screen shows the difference and makes the
   * student confirm, rather than quietly charging the new price.
   */
  unitPriceMinor: number;
  quantity: number;
  note?: string;
}

export interface Cart {
  /**
   * Whose cart this is. A phone gets passed around and accounts get swapped
   * on it; a cart with no owner showed the last person's samosas to the next
   * person to sign in.
   */
  ownerId: string;
  listingId: string;
  shopName: string;
  lines: CartLine[];
}

interface CartContextValue {
  cart: Cart | null;
  /**
   * False until the saved cart has been read. Until then "no cart" means
   * "not looked yet", and a screen that treats it as empty flashes "Your
   * cart is empty" at someone who has a full one.
   */
  hydrated: boolean;
  /** Lines for the shop being viewed, or an empty array for any other shop. */
  linesFor(listingId: string): CartLine[];
  quantityOf(listingId: string, catalogItemId: string): number;
  itemCount: number;
  subtotalMinor: number;
  add(listingId: string, shopName: string, line: Omit<CartLine, 'quantity'>): void;
  setQuantity(catalogItemId: string, quantity: number): void;
  setNote(catalogItemId: string, note: string): void;
  clear(): void;
}

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = 'hoppo.student.cart';

/**
 * The cart.
 *
 * Two constraints come straight from the ordering model and shape everything:
 *
 *  - **One shop per cart.** An order belongs to a single shop listing, because
 *    one shop accepts it and one prep time applies. So adding an item from a
 *    second shop replaces the cart rather than merging — and the shop screen
 *    asks before it does, because silently discarding a cart someone spent two
 *    minutes building is worse than an extra tap.
 *  - **Prices are not trusted from here.** See `unitPriceMinor` above.
 *
 * Scoped to the signed-in student. The saved cart records its owner and is
 * dropped when somebody else signs in; an explicit sign-out empties it too
 * (see `SignOutButton`). A session that merely expires does not, so signing
 * back in as the same person finds the cart where it was left.
 *
 * Persisted to `localStorage` so switching to Maps to find a drop point, or
 * taking a call, does not lose the cart. Everything is in integer paise; a
 * float total drifts by a rupee over enough additions and then disagrees with
 * the server for reasons nobody can reproduce.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useApi();
  const userId = user?.id ?? null;

  const [cart, setCart] = useState<Cart | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Read after mount rather than during render. The server has no
  // localStorage, so reading it during the first render makes the server and
  // client markup disagree and React discards the tree.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setCart(JSON.parse(raw) as Cart);
    } catch {
      // A corrupt or unreadable cart is an empty cart, not a crash.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (cart && cart.lines.length > 0) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* in-memory only */
    }
  }, [cart, hydrated]);

  // Somebody else's cart is not this student's cart. Checked once the saved
  // cart and the signed-in user are both known — either can arrive first.
  useEffect(() => {
    if (!hydrated || authLoading || !userId) return;
    setCart((current) => (current && current.ownerId !== userId ? null : current));
  }, [hydrated, authLoading, userId]);

  const add = useCallback(
    (listingId: string, shopName: string, line: Omit<CartLine, 'quantity'>) => {
      // Every screen that can add is behind sign-in, so there is always an
      // owner. Refusing quietly beats saving a cart that belongs to nobody.
      if (!userId) return;

      setCart((current) => {
        // A different shop replaces the cart. The caller is responsible for
        // confirming that with the student first.
        if (!current || current.listingId !== listingId) {
          return { ownerId: userId, listingId, shopName, lines: [{ ...line, quantity: 1 }] };
        }

        const existing = current.lines.find((l) => l.catalogItemId === line.catalogItemId);
        if (existing) {
          return {
            ...current,
            lines: current.lines.map((l) =>
              l.catalogItemId === line.catalogItemId
                ? { ...l, quantity: Math.min(l.quantity + 1, MAX_CART_ITEM_QUANTITY) }
                : l,
            ),
          };
        }

        return { ...current, lines: [...current.lines, { ...line, quantity: 1 }] };
      });
    },
    [userId],
  );

  const setQuantity = useCallback((catalogItemId: string, quantity: number) => {
    setCart((current) => {
      if (!current) return current;

      const lines =
        quantity <= 0
          ? current.lines.filter((l) => l.catalogItemId !== catalogItemId)
          : current.lines.map((l) => (l.catalogItemId === catalogItemId ? { ...l, quantity } : l));

      // An empty cart is no cart, so the shop name does not linger and the
      // next shop starts clean.
      return lines.length > 0 ? { ...current, lines } : null;
    });
  }, []);

  const setNote = useCallback((catalogItemId: string, note: string) => {
    setCart((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((l) =>
              l.catalogItemId === catalogItemId ? { ...l, note: note || undefined } : l,
            ),
          }
        : current,
    );
  }, []);

  const clear = useCallback(() => setCart(null), []);

  const value = useMemo<CartContextValue>(() => {
    const lines = cart?.lines ?? [];

    return {
      cart,
      hydrated,
      linesFor: (listingId: string) => (cart?.listingId === listingId ? cart.lines : []),
      quantityOf: (listingId: string, catalogItemId: string) =>
        cart?.listingId === listingId
          ? (cart.lines.find((l) => l.catalogItemId === catalogItemId)?.quantity ?? 0)
          : 0,
      itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotalMinor: lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0),
      add,
      setQuantity,
      setNote,
      clear,
    };
  }, [cart, hydrated, add, setQuantity, setNote, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside a CartProvider');
  return ctx;
}
