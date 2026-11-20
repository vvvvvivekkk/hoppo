'use client';

import type { AdminStudentListItem, AdminStudentListQuery } from '@hoppo/api-client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Empty, Field, Panel } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  ACCOUNT_STATUS,
  AccountPill,
  STUDENT_TABS,
  Select,
  Tabs,
  VERIFICATION_STATUS,
  explain,
  label,
  useAction,
  when,
} from '@/lib/kit';

/** A-04, finding the student: search by name, mobile, email or roll number. */
interface Filters {
  q: string;
  status: '' | NonNullable<AdminStudentListQuery['status']>;
  verificationStatus: '' | NonNullable<AdminStudentListQuery['verificationStatus']>;
}

const NO_FILTERS: Filters = { q: '', status: '', verificationStatus: '' };

const toQuery = (f: Filters): AdminStudentListQuery => ({
  q: f.q.trim() || undefined,
  status: f.status || undefined,
  verificationStatus: f.verificationStatus || undefined,
});

export default function FindStudentsPage() {
  const { api } = useApi();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<AdminStudentListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useAction();
  const more = useAction();

  const read = useCallback(
    (filters: Filters) =>
      load.run(async () => {
        try {
          const page = await api.admin.listStudents({ ...toQuery(filters), limit: 25 });
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
        const page = await api.admin.listStudents({ ...toQuery(applied), limit: 25, cursor: nextCursor });
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setNextCursor(page.nextCursor);
      } catch (e) {
        setError(explain(e));
      }
    });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black tracking-tight">Students</h1>
      <Tabs current="/students/find" tabs={STUDENT_TABS} />

      <Panel title="Find a student">
        <form
          className="grid gap-3 p-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void read(draft);
          }}
        >
          <div className="sm:col-span-2">
            <Field
              label="Name, mobile, email or roll number"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>
          <Select
            label="Account"
            value={draft.status}
            onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value as Filters['status'] }))}
          >
            <option value="">Any</option>
            {Object.entries(ACCOUNT_STATUS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <Select
            label="Verification"
            value={draft.verificationStatus}
            onChange={(e) =>
              setDraft((p) => ({ ...p, verificationStatus: e.target.value as Filters['verificationStatus'] }))
            }
          >
            <option value="">Any</option>
            {(['UNSUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'] as const).map((value) => (
              <option key={value} value={value}>
                {VERIFICATION_STATUS[value]}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-4">
            <Button type="submit" loading={load.busy}>
              Search
            </Button>
          </div>
        </form>
      </Panel>

      {error && <Banner tone="error">{error}</Banner>}

      <Panel>
        {items === null ? (
          <Empty title="Loading…" body="Fetching students." />
        ) : items.length === 0 ? (
          <Empty title="No student matches" body="Check the spelling, or search by mobile number or roll number instead." />
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-line)] text-sm">
              {items.map((student) => (
                <li key={student.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Link
                    href={`/students/${student.id}`}
                    className="min-w-48 font-bold text-[var(--color-accent)] underline"
                  >
                    {student.name}
                  </Link>
                  <AccountPill status={student.status} />
                  <span className="text-[var(--color-ink-soft)]">
                    {label(VERIFICATION_STATUS, student.verificationStatus)}
                  </span>
                  <span className="nums">{student.rollNumber ?? 'no roll number'}</span>
                  <span className="nums">{student.mobile}</span>
                  <span>{student.email}</span>
                  <span className="nums text-[var(--color-ink-faint)]">joined {when(student.createdAt)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-3 text-sm">
              <span className="text-[var(--color-ink-faint)]">
                Showing {items.length}
                {nextCursor ? '' : ' — that is everyone who matches'}
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
