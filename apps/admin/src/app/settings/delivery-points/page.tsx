'use client';

import type { AdminDeliveryPoint } from '@hoppo/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Empty, Field, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import { SETTINGS_TABS, Tabs, explain, useAction, useKeyedAction } from '@/lib/kit';

/**
 * A-10: campus delivery points (FR-ORD-02).
 *
 * The places a student can choose at checkout, in the order they are listed
 * there. A point is never deleted — orders refer to it — so it is switched
 * off instead, and inactive points stay on this list so they can be switched
 * back on. The SRS describes a map editor; this is a list with coordinates,
 * with a link out to a map for checking a pin.
 */
const REFUSALS = {
  DELIVERY_POINT_NAME_TAKEN: 'Another delivery point at this college already has that name. Choose a different one.',
  DELIVERY_POINT_TOO_FAR:
    'Those coordinates are more than 5 km from the college, which is too far for a campus delivery point. Check the latitude and longitude.',
  REORDER_MISMATCH: 'The list of points changed while you were reordering. It has been reloaded; try again.',
  ALREADY_INACTIVE: 'That point was already switched off. The list below is up to date.',
  ALREADY_ACTIVE: 'That point was already switched on. The list below is up to date.',
  EMPTY_UPDATE: 'Nothing was different, so nothing was changed.',
  NOT_FOUND: 'That delivery point no longer exists. The list below is up to date.',
};

interface Form {
  name: string;
  description: string;
  latitude: string;
  longitude: string;
}

const EMPTY: Form = { name: '', description: '', latitude: '', longitude: '' };

/** The form as the API wants it, or what is wrong with it. */
function parse(form: Form): { problem: string } | { name: string; description: string; latitude: number; longitude: number } {
  const name = form.name.trim();
  if (name.length < 2 || name.length > 100) return { problem: 'The name has to be between 2 and 100 characters.' };
  if (form.description.trim().length > 300) return { problem: 'Keep the description under 300 characters.' };
  const latitude = Number(form.latitude);
  const longitude = Number(form.longitude);
  if (form.latitude.trim() === '' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { problem: 'Enter the latitude as a number, for example 17.3047.' };
  }
  if (form.longitude.trim() === '' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { problem: 'Enter the longitude as a number, for example 78.6192.' };
  }
  return { name, description: form.description.trim(), latitude, longitude };
}

export default function DeliveryPointsPage() {
  const { api } = useApi();
  const [points, setPoints] = useState<AdminDeliveryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form>(EMPTY);
  const adding = useAction();
  const ordering = useAction();
  const rows = useKeyedAction();

  const load = useCallback(async () => {
    try {
      const result = await api.admin.deliveryPoints.list();
      setPoints(result.points);
    } catch (e) {
      setError(explain(e, REFUSALS));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change, then show the list as the server has it — also after a refusal. */
  async function settle(request: () => Promise<string>) {
    setError(null);
    setNotice(null);
    try {
      const message = await request();
      await load();
      setNotice(message);
    } catch (e) {
      await load();
      setError(explain(e, REFUSALS));
    }
  }

  const add = () =>
    adding.run(async () => {
      const parsed = parse(form);
      if ('problem' in parsed) {
        setFormProblem(parsed.problem);
        return;
      }
      setFormProblem(null);
      await settle(async () => {
        const created = await api.admin.deliveryPoints.create({
          name: parsed.name,
          description: parsed.description || undefined,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
        });
        setForm(EMPTY);
        return `${created.name} added at the end of the list. Students can choose it at checkout now.`;
      });
    });

  const saveEdit = (point: AdminDeliveryPoint) =>
    rows.run(point.id, async () => {
      const parsed = parse(edit);
      if ('problem' in parsed) {
        setError(parsed.problem);
        return;
      }
      await settle(async () => {
        const updated = await api.admin.deliveryPoints.update(point.id, {
          name: parsed.name,
          description: parsed.description || null,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
        });
        setEditing(null);
        return `${updated.name} saved.`;
      });
    });

  const toggle = (point: AdminDeliveryPoint) =>
    rows.run(point.id, () =>
      settle(async () => {
        if (point.isActive) {
          await api.admin.deliveryPoints.deactivate(point.id);
          return `${point.name} switched off. Students no longer see it at checkout; orders that used it keep their history.`;
        }
        await api.admin.deliveryPoints.activate(point.id);
        return `${point.name} switched on. Students can choose it at checkout again.`;
      }),
    );

  const move = (index: number, by: -1 | 1) =>
    ordering.run(async () => {
      if (!points) return;
      const target = index + by;
      if (target < 0 || target >= points.length) return;
      const next = [...points];
      [next[index], next[target]] = [next[target], next[index]];
      await settle(async () => {
        // The API wants every point of the college, each once, in the new order.
        await api.admin.deliveryPoints.reorder(next.map((p) => p.id));
        return `${points[index].name} moved ${by === -1 ? 'up' : 'down'}. This is the order students see.`;
      });
    });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">College settings</h1>
      <Tabs current="/settings/delivery-points" tabs={SETTINGS_TABS} />

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Panel
        title="Delivery points"
        subtitle="In the order students see them at checkout. Switched-off points are kept, not deleted."
      >
        {points === null ? (
          <Empty title="Loading…" body="Fetching delivery points." />
        ) : points.length === 0 ? (
          <Empty
            title="No delivery points yet"
            body="Without one, students have to describe where they are in words. Add the hostel gates and the library first."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {points.map((point, index) => {
              const busy = rows.busyKeys.has(point.id);
              return (
                <li key={point.id} className={`p-4 ${point.isActive ? '' : 'bg-[var(--color-surface-sunken)]'}`}>
                  {editing === point.id ? (
                    <div className="space-y-3">
                      <PointFields form={edit} onChange={setEdit} prefix={`Edit ${point.name}`} />
                      <div className="flex gap-2">
                        <Button loading={busy} onClick={() => void saveEdit(point)}>
                          Save
                        </Button>
                        <Button tone="quiet" disabled={busy} onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="nums w-6 text-sm text-[var(--color-ink-faint)]">{index + 1}</span>
                      <div className="min-w-56 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-bold">
                          {point.name}
                          {point.isActive ? <Pill tone="ok">shown to students</Pill> : <Pill tone="plain">switched off</Pill>}
                        </p>
                        <p className="text-sm text-[var(--color-ink-soft)]">
                          {point.description ?? 'No description'}
                        </p>
                        <p className="nums text-xs text-[var(--color-ink-faint)]">
                          {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)} ·{' '}
                          <a
                            className="underline"
                            target="_blank"
                            rel="noreferrer noopener"
                            href={`https://www.google.com/maps?q=${point.latitude},${point.longitude}`}
                          >
                            see on a map
                          </a>{' '}
                          · used by {point.orderCount} order{point.orderCount === 1 ? '' : 's'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          tone="quiet"
                          aria-label={`Move ${point.name} up`}
                          disabled={index === 0 || ordering.busy}
                          onClick={() => void move(index, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          tone="quiet"
                          aria-label={`Move ${point.name} down`}
                          disabled={index === points.length - 1 || ordering.busy}
                          onClick={() => void move(index, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          tone="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditing(point.id);
                            setEdit({
                              name: point.name,
                              description: point.description ?? '',
                              latitude: String(point.latitude),
                              longitude: String(point.longitude),
                            });
                          }}
                        >
                          Edit
                        </Button>
                        <Button tone={point.isActive ? 'danger' : 'approve'} loading={busy} onClick={() => void toggle(point)}>
                          {point.isActive ? 'Switch off' : 'Switch on'}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Add a delivery point" subtitle="It has to be within 5 km of the college">
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <PointFields form={form} onChange={setForm} prefix="New point" />
          {formProblem && <Banner tone="error">{formProblem}</Banner>}
          <Button type="submit" loading={adding.busy}>
            Add delivery point
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function PointFields({
  form,
  onChange,
  prefix,
}: {
  form: Form;
  onChange: (next: Form) => void;
  prefix: string;
}) {
  const id = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field id={`${id}-name`} label="Name" placeholder="Central Library" value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
      <Field
        id={`${id}-description`}
        label="Description (optional)"
        placeholder="Main entrance"
        value={form.description}
        onChange={(e) => onChange({ ...form, description: e.target.value })}
      />
      <Field
        id={`${id}-latitude`}
        label="Latitude"
        inputMode="decimal"
        placeholder="17.3047"
        value={form.latitude}
        onChange={(e) => onChange({ ...form, latitude: e.target.value })}
      />
      <Field
        id={`${id}-longitude`}
        label="Longitude"
        inputMode="decimal"
        placeholder="78.6192"
        value={form.longitude}
        onChange={(e) => onChange({ ...form, longitude: e.target.value })}
      />
    </div>
  );
}
