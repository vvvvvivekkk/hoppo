'use client';

import type { PlatformAdmin, PlatformCollege } from '@hoppo/api-client';
import { formatDistance } from '@hoppo/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ReasonAction } from '@/components/reason-action';
import { Banner, Button, Detail, Empty, Field, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import { explain, useAction, useKeyedAction, when } from '@/lib/kit';

/**
 * A-18 and A-16: one college, and the administrators who run it (FR-ADM-07).
 *
 * An administrator belongs to exactly one college (FR-TEN-02), so "assigning"
 * one means creating the account here. There are no email invitations in this
 * release: the platform administrator sets the first password and passes it
 * on, which the form says rather than implying an invite is sent.
 */
const REFUSALS = {
  NOT_FOUND: 'There is no college with that id.',
  ALREADY_EXISTS: 'An account with that mobile number or email already exists. Each person has one account.',
  COLLEGE_INACTIVE: 'This college is inactive, so an administrator cannot be added to it. Activate it first.',
  ALREADY_INACTIVE: 'That was already switched off. The page below is up to date.',
  ALREADY_ACTIVE: 'That was already active. The page below is up to date.',
  NOT_AN_ADMIN: 'That account is not a college administrator.',
};

const BLANK = { name: '', mobile: '', email: '', password: '' };

export default function CollegePage() {
  const { api } = useApi();
  const { collegeId } = useParams<{ collegeId: string }>();
  const [college, setCollege] = useState<(PlatformCollege & { admins: PlatformAdmin[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [problem, setProblem] = useState<string | null>(null);
  const collegeAction = useAction();
  const creating = useAction();
  const rows = useKeyedAction();

  const load = useCallback(async () => {
    try {
      setCollege(await api.superAdmin.college(collegeId));
    } catch (e) {
      setError(explain(e, REFUSALS));
    }
  }, [api, collegeId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Make the change, then show the college as the server has it either way. */
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

  const createAdmin = () =>
    creating.run(async () => {
      const name = form.name.trim();
      const email = form.email.trim().toLowerCase();
      const mobile = form.mobile.trim();
      const invalid =
        name.length < 2
          ? 'Enter the administrator’s name.'
          : !/^\+?\d{10,15}$/.test(mobile)
            ? 'Enter their mobile number, digits only, with the country code if it is not an Indian number.'
            : !/^\S+@\S+\.\S+$/.test(email)
              ? 'Enter their email address.'
              : form.password.length < 10
                ? 'The first password has to be at least 10 characters.'
                : null;
      if (invalid) {
        setProblem(invalid);
        return;
      }
      setProblem(null);
      await settle(async () => {
        const admin = await api.superAdmin.createAdmin(collegeId, { name, mobile, email, password: form.password });
        setForm(BLANK);
        return `${admin.name} can now sign in to this console as an administrator of this college. No email was sent: give them the password yourself.`;
      });
    });

  return (
    <div className="space-y-4">
      <Link href="/platform" className="text-sm font-semibold text-[var(--color-accent)] underline">
        ← All colleges
      </Link>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {!college && !error && <Empty title="Loading…" body="Fetching the college." />}

      {college && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight">{college.name}</h1>
            <Pill tone={college.status === 'ACTIVE' ? 'ok' : 'plain'}>
              {college.status === 'ACTIVE' ? 'active' : 'inactive'}
            </Pill>
          </div>

          <Panel title="College">
            <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Short name" value={college.shortName ?? 'None'} />
              <Detail label="Address" value={`${college.address}, ${college.city}, ${college.state}`} />
              <Detail
                label="Campus coordinates"
                value={`${college.latitude.toFixed(5)}, ${college.longitude.toFixed(5)}`}
                nums
              />
              <Detail label="Serviceable radius" value={formatDistance(college.serviceableRadiusM)} nums />
              <Detail label="Timezone" value={college.timezone} />
              <Detail label="Student email domain" value={college.emailDomain ?? 'Any'} />
              <Detail label="Students" value={college.counts.students} nums />
              <Detail label="Shop listings" value={college.counts.shopListings} nums />
              <Detail label="Created" value={when(college.createdAt)} nums />
            </dl>
          </Panel>

          <Panel title="Switch this college off or on">
            <div className="p-4">
              {college.status === 'ACTIVE' ? (
                <ReasonAction
                  trigger="Deactivate this college…"
                  title={`Deactivate ${college.name}`}
                  effects={
                    <ul className="list-disc space-y-1 pl-5">
                      <li>Nobody at this college can sign in or register, and it leaves the list of colleges at sign-up.</li>
                      <li>
                        Its {college.counts.students} student{college.counts.students === 1 ? '' : 's'} and{' '}
                        {college.counts.shopListings} shop listing{college.counts.shopListings === 1 ? '' : 's'} are
                        refused on every request until it is activated again.
                      </li>
                      <li>Nothing is deleted. Activating it restores access.</li>
                    </ul>
                  }
                  confirmLabel="Confirm: deactivate"
                  busy={collegeAction.busy}
                  onConfirm={(reason) =>
                    void collegeAction.run(() =>
                      settle(async () => {
                        const result = await api.superAdmin.deactivateCollege(collegeId, reason);
                        return `${result.name} is now inactive.`;
                      }),
                    )
                  }
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    tone="approve"
                    loading={collegeAction.busy}
                    onClick={() =>
                      void collegeAction.run(() =>
                        settle(async () => {
                          const result = await api.superAdmin.activateCollege(collegeId);
                          return `${result.name} is active again.`;
                        }),
                      )
                    }
                  >
                    Activate this college
                  </Button>
                  <span className="text-sm text-[var(--color-ink-faint)]">
                    Its students, shops and administrators can sign in again.
                  </span>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Administrators" subtitle="The people who can sign in to this console for this college">
            {college.admins.length === 0 ? (
              <Empty
                title="No administrator yet"
                body="Until there is one, nobody can approve this college's students or shops. Add one below."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {college.admins.map((admin) => {
                  const busy = rows.busyKeys.has(admin.id);
                  return (
                    <li key={admin.id} className="space-y-3 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="min-w-40 font-bold">{admin.name}</span>
                        <Pill tone={admin.status === 'ACTIVE' ? 'ok' : 'danger'}>
                          {admin.status === 'ACTIVE'
                            ? 'active'
                            : admin.status === 'DEACTIVATED'
                              ? 'deactivated'
                              : 'suspended'}
                        </Pill>
                        <span>{admin.email}</span>
                        <span className="nums">{admin.mobile}</span>
                        <span className="nums text-[var(--color-ink-faint)]">
                          {admin.lastLoginAt ? `last signed in ${when(admin.lastLoginAt)}` : 'has never signed in'}
                        </span>
                      </div>
                      {admin.status === 'ACTIVE' && (
                        <ReasonAction
                          trigger={`Deactivate ${admin.name}…`}
                          title={`Deactivate ${admin.name}`}
                          effects={
                            <p>
                              They are signed out everywhere at once and cannot sign in again until
                              reactivated. Decisions they already made stand.
                            </p>
                          }
                          confirmLabel="Confirm: deactivate"
                          busy={busy}
                          onConfirm={(reason) =>
                            void rows.run(admin.id, () =>
                              settle(async () => {
                                const result = await api.superAdmin.deactivateAdmin(admin.id, reason);
                                return `${result.name} has been deactivated and signed out.`;
                              }),
                            )
                          }
                        />
                      )}
                      {admin.status === 'DEACTIVATED' && (
                        <Button
                          tone="approve"
                          loading={busy}
                          onClick={() =>
                            void rows.run(admin.id, () =>
                              settle(async () => {
                                const result = await api.superAdmin.reactivateAdmin(admin.id);
                                return `${result.name} can sign in again.`;
                              }),
                            )
                          }
                        >
                          Reactivate {admin.name}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            title="Add an administrator"
            subtitle="Creates the account now. No invitation is emailed — you set the first password and give it to them."
          >
            <form
              className="space-y-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void createAdmin();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
                <Field
                  label="Mobile number"
                  inputMode="tel"
                  placeholder="+919876543210"
                  value={form.mobile}
                  onChange={(e) => setForm((p) => ({ ...p, mobile: e.target.value }))}
                />
                <Field
                  label="Email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                />
                <Field
                  label="First password"
                  hint="At least 10 characters"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                />
              </div>
              {problem && <Banner tone="error">{problem}</Banner>}
              <Button type="submit" loading={creating.busy} disabled={college.status !== 'ACTIVE'}>
                Add administrator
              </Button>
              {college.status !== 'ACTIVE' && (
                <p className="text-sm text-[var(--color-ink-faint)]">
                  Activate the college before adding an administrator to it.
                </p>
              )}
            </form>
          </Panel>
        </>
      )}
    </div>
  );
}
