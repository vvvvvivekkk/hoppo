'use client';

import { formatMinor, rupeesToMinor, minorToRupees } from '@hoppo/shared';
import type { CatalogItem } from '@hoppo/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Card, EmptyState, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useListing } from '@/lib/use-listing';

/**
 * D-11 and D-12: the menu.
 *
 * One screen rather than a list and a separate editor. A shop owner adjusting
 * a price or marking something sold out is doing it between customers, and a
 * round trip to another page for a one-field change is the kind of friction
 * that ends with the menu going stale.
 */
export default function CatalogPage() {
  const { api } = useApi();
  const { listingId, shop, error: listingError, loading } = useListing();

  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.catalog.get>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!listingId) return;
    try {
      setCatalog(await api.catalog.get(listingId));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api, listingId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-[var(--color-ink-faint)]">Loading…</p>;
  if (listingError) return <Banner tone="error">{listingError}</Banner>;
  if (!listingId) return <EmptyState title="No shop yet" body="Register a shop to add a menu." />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Menu</h1>
        <p className="text-[var(--color-ink-faint)]">{shop?.name}</p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <NewCategory
        disabled={busy}
        onCreate={(name) => run(() => api.catalog.createCategory(listingId, name))}
      />

      {catalog?.categories.length === 0 && catalog?.uncategorised.length === 0 && (
        <EmptyState
          title="Nothing on the menu yet"
          body="Add a category first — Beverages, Snacks, Meals — then add items to it."
        />
      )}

      {catalog?.categories.map((category) => (
        <Card key={category.id} className="overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-5 py-3">
            <h2 className="text-xl font-bold">{category.name}</h2>
            <span className="text-[var(--color-ink-faint)]">
              {category.items.length} item{category.items.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="divide-y divide-[var(--color-line)]">
            {category.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                disabled={busy}
                onToggle={() =>
                  run(() =>
                    api.catalog.setAvailability(listingId, [item.id], !item.isAvailable),
                  )
                }
                onSave={(body) => run(() => api.catalog.updateItem(listingId, item.id, body))}
                onDelete={() => run(() => api.catalog.deleteItem(listingId, item.id))}
              />
            ))}

            <NewItem
              disabled={busy}
              onCreate={(body) =>
                run(() => api.catalog.createItem(listingId, { ...body, categoryId: category.id }))
              }
            />
          </div>
        </Card>
      ))}

      {catalog && catalog.uncategorised.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-5 py-3">
            <h2 className="text-xl font-bold">Not in a category</h2>
            <p className="text-sm text-[var(--color-ink-faint)]">
              These still show to students. Deleting a category keeps its items rather than
              removing them.
            </p>
          </div>
          <div className="divide-y divide-[var(--color-line)]">
            {catalog.uncategorised.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                disabled={busy}
                onToggle={() =>
                  run(() => api.catalog.setAvailability(listingId, [item.id], !item.isAvailable))
                }
                onSave={(body) => run(() => api.catalog.updateItem(listingId, item.id, body))}
                onDelete={() => run(() => api.catalog.deleteItem(listingId, item.id))}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function NewCategory({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim());
        setName('');
      }}
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--color-line)] bg-white p-4"
    >
      <div className="min-w-56 flex-1">
        <Field
          label="New category"
          placeholder="Beverages"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={disabled || !name.trim()}>
        Add category
      </Button>
    </form>
  );
}

/**
 * One menu row.
 *
 * The availability toggle is the frequent action — "we've run out of thalis"
 * happens several times a day — so it is a single large control and not
 * hidden behind an edit mode. FR-CAT-03 marks an item unavailable rather than
 * deleting it, which is what keeps order history resolvable.
 */
function ItemRow({
  item,
  disabled,
  onToggle,
  onSave,
  onDelete,
}: {
  item: CatalogItem;
  disabled: boolean;
  onToggle: () => void;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  // Rupees in the input, paise on the wire. The conversion happens once, here
  // at the edge — FR-PAY-07 keeps everything inside the system as integers.
  const [rupees, setRupees] = useState(String(minorToRupees(item.priceMinor)));
  const [prep, setPrep] = useState(String(item.prepMinutes));
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            name: name.trim(),
            priceMinor: rupeesToMinor(Number(rupees)),
            prepMinutes: Number(prep),
          });
          setEditing(false);
        }}
        className="space-y-3 bg-[var(--color-surface-sunken)] p-5"
      >
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <div className="flex flex-wrap gap-3">
          <div className="min-w-32 flex-1">
            <Field
              label="Price (₹)"
              type="number"
              step="0.5"
              min="0"
              inputMode="decimal"
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              required
            />
          </div>
          <div className="min-w-32 flex-1">
            <Field
              label="Preparation (min)"
              hint="Decides when a rider is called"
              type="number"
              min="0"
              max="240"
              inputMode="numeric"
              value={prep}
              onChange={(e) => setPrep(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="flex gap-3">
          <Button type="submit" disabled={disabled}>
            Save
          </Button>
          <Button tone="quiet" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-4 p-5 ${
        item.isAvailable ? '' : 'bg-[var(--color-surface-sunken)]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p
          className={`text-lg font-semibold ${
            item.isAvailable ? '' : 'text-[var(--color-ink-faint)] line-through'
          }`}
        >
          {item.name}
        </p>
        <p className="text-[var(--color-ink-faint)]">
          {formatMinor(item.priceMinor)} · {item.prepMinutes} min
          {!item.isAvailable && ' · sold out'}
        </p>
      </div>

      <Button
        tone={item.isAvailable ? 'secondary' : 'primary'}
        disabled={disabled}
        onClick={onToggle}
      >
        {item.isAvailable ? 'Mark sold out' : 'Back in stock'}
      </Button>

      <Button tone="quiet" disabled={disabled} onClick={() => setEditing(true)}>
        Edit
      </Button>

      {!confirmDelete ? (
        <Button tone="quiet" disabled={disabled} onClick={() => setConfirmDelete(true)}>
          Remove
        </Button>
      ) : (
        <span className="flex items-center gap-2">
          <Button tone="danger" disabled={disabled} onClick={onDelete}>
            Remove for good
          </Button>
          <Button tone="quiet" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
        </span>
      )}
    </div>
  );
}

function NewItem({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rupees, setRupees] = useState('');
  const [prep, setPrep] = useState('10');

  if (!open) {
    return (
      <div className="p-4">
        <Button tone="secondary" onClick={() => setOpen(true)} disabled={disabled}>
          Add item
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({
          name: name.trim(),
          priceMinor: rupeesToMinor(Number(rupees)),
          prepMinutes: Number(prep),
        });
        setName('');
        setRupees('');
        setPrep('10');
        setOpen(false);
      }}
      className="space-y-3 bg-[var(--color-surface-sunken)] p-5"
    >
      <Field label="Name" placeholder="Masala Chai" value={name} onChange={(e) => setName(e.target.value)} required />
      <div className="flex flex-wrap gap-3">
        <div className="min-w-32 flex-1">
          <Field
            label="Price (₹)"
            type="number"
            step="0.5"
            min="0"
            inputMode="decimal"
            value={rupees}
            onChange={(e) => setRupees(e.target.value)}
            required
          />
        </div>
        <div className="min-w-32 flex-1">
          <Field
            label="Preparation (min)"
            type="number"
            min="0"
            max="240"
            inputMode="numeric"
            value={prep}
            onChange={(e) => setPrep(e.target.value)}
            required
          />
        </div>
      </div>
      <div className="flex gap-3">
        <Button type="submit" disabled={disabled || !name.trim() || !rupees}>
          Add
        </Button>
        <Button tone="quiet" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
