'use client';

import type { PlatformCollege } from '@hoppo/api-client';
import { RADIUS_MAX_M, RADIUS_MIN_M, formatDistance } from '@hoppo/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Empty, Field, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import { explain, useAction, when } from '@/lib/kit';

/**
 * A-18: colleges on the platform (FR-TEN-01). Platform administrators only —
 * the shell does not render this page for anyone else.
 */
const REFUSALS = {
  COLLEGE_NAME_TAKEN: 'There is already a college with that name. Use its full, distinct name.',
  EMAIL_DOMAIN_TAKEN: 'Another college already uses that email domain. Each college needs its own.',
  INVALID_TIMEZONE: 'That is not a timezone name the server knows. Use a name like Asia/Kolkata.',
};

const BLANK = {
  name: '',
  shortName: '',
  address: '',
  city: '',
  state: '',
  latitude: '',
  longitude: '',
  radiusKm: '3',
  timezone: 'Asia/Kolkata',
  emailDomain: '',
};

export default function PlatformPage() {
  const { api } = useApi();
  const [colleges, setColleges] = useState<PlatformCollege[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [problem, setProblem] = useState<string | null>(null);
  const creating = useAction();

  const load = useCallback(async () => {
    try {
      setColleges((await api.superAdmin.colleges()).colleges);
    } catch (e) {
      setError(explain(e, REFUSALS));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<typeof BLANK>) => setForm((prev) => ({ ...prev, ...patch }));

  const create = () =>
    creating.run(async () => {
      setError(null);
      setNotice(null);

      const name = form.name.trim();
      const latitude = Number(form.latitude);
      const longitude = Number(form.longitude);
      const radiusM = Math.round(Number(form.radiusKm) * 1000);

      const invalid =
        name.length < 2 || name.length > 150
          ? 'Enter the college name (2 to 150 characters).'
          : !form.address.trim() || !form.city.trim() || !form.state.trim()
            ? 'Address, city and state are all needed.'
            : form.latitude.trim() === '' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
              ? 'Enter the campus latitude as a number, for example 17.3045.'
              : form.longitude.trim() === '' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
                ? 'Enter the campus longitude as a number, for example 78.6188.'
                : !Number.isFinite(radiusM) || radiusM < RADIUS_MIN_M || radiusM > RADIUS_MAX_M
                  ? `The serviceable radius has to be between ${formatDistance(RADIUS_MIN_M)} and ${formatDistance(RADIUS_MAX_M)}.`
                  : null;

      if (invalid) {
        setProblem(invalid);
        return;
      }
      setProblem(null);

      try {
        const college = await api.superAdmin.createCollege({
          name,
          shortName: form.shortName.trim() || undefined,
          address: form.address.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          latitude,
          longitude,
          serviceableRadiusM: radiusM,
          timezone: form.timezone.trim() || undefined,
          emailDomain: form.emailDomain.trim().toLowerCase() || undefined,
        });
        setForm(BLANK);
        await load();
        setNotice(
          `${college.name} created with default fees and settings. It has no administrator yet — open it below to add one.`,
        );
      } catch (e) {
        setError(explain(e, REFUSALS));
      }
    });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Colleges</h1>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <Panel title="Every college on the platform" subtitle="Including inactive ones">
        {colleges === null ? (
          <Empty title="Loading…" body="Fetching colleges." />
        ) : colleges.length === 0 ? (
          <Empty title="No colleges yet" body="Create the first one below." />
        ) : (
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {colleges.map((college) => (
              <li key={college.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link
                  href={`/platform/${college.id}`}
                  className="min-w-56 font-bold text-[var(--color-accent)] underline"
                >
                  {college.name}
                </Link>
                <Pill tone={college.status === 'ACTIVE' ? 'ok' : 'plain'}>
                  {college.status === 'ACTIVE' ? 'active' : 'inactive'}
                </Pill>
                <span>
                  {college.city}, {college.state}
                </span>
                <span className="nums">radius {formatDistance(college.serviceableRadiusM)}</span>
                <span className="nums">
                  {college.counts.admins} administrator{college.counts.admins === 1 ? '' : 's'} ·{' '}
                  {college.counts.students} student{college.counts.students === 1 ? '' : 's'} ·{' '}
                  {college.counts.shopListings} shop{college.counts.shopListings === 1 ? '' : 's'}
                </span>
                <span className="nums text-[var(--color-ink-faint)]">created {when(college.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Create a college"
        subtitle="It starts active, with default fee bands and settings, and no administrator"
      >
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="College name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            <Field label="Short name (optional)" value={form.shortName} onChange={(e) => set({ shortName: e.target.value })} />
            <Field
              label="Student email domain (optional)"
              placeholder="college.edu.in"
              value={form.emailDomain}
              onChange={(e) => set({ emailDomain: e.target.value })}
            />
            <Field label="Address" value={form.address} onChange={(e) => set({ address: e.target.value })} />
            <Field label="City" value={form.city} onChange={(e) => set({ city: e.target.value })} />
            <Field label="State" value={form.state} onChange={(e) => set({ state: e.target.value })} />
            <Field
              label="Campus latitude"
              inputMode="decimal"
              placeholder="17.3045"
              value={form.latitude}
              onChange={(e) => set({ latitude: e.target.value })}
            />
            <Field
              label="Campus longitude"
              inputMode="decimal"
              placeholder="78.6188"
              value={form.longitude}
              onChange={(e) => set({ longitude: e.target.value })}
            />
            <Field
              label="Serviceable radius (km)"
              hint={`${formatDistance(RADIUS_MIN_M)} to ${formatDistance(RADIUS_MAX_M)}`}
              inputMode="decimal"
              value={form.radiusKm}
              onChange={(e) => set({ radiusKm: e.target.value })}
            />
            <Field
              label="Timezone"
              hint="Dates in reports are read in this timezone"
              value={form.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
            />
          </div>
          {problem && <Banner tone="error">{problem}</Banner>}
          <Button type="submit" loading={creating.busy}>
            Create college
          </Button>
        </form>
      </Panel>
    </div>
  );
}
