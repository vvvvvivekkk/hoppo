'use client';

import type { AdminStudentDetail } from '@hoppo/api-client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ReasonAction } from '@/components/reason-action';
import { Banner, Button, Detail, Empty, Panel, Pill } from '@/components/ui';
import { useApi } from '@/lib/api';
import {
  AccountPill,
  OrderStatusPill,
  TASK_STATUS,
  TASK_TYPE,
  VERIFICATION_STATUS,
  explain,
  label,
  money,
  useAction,
  when,
  words,
} from '@/lib/kit';

/**
 * A-04: one student — profile, verification history, recent orders and
 * deliveries, and suspend / reinstate (FR-SVER-08).
 */
const REFUSALS = {
  NOT_A_STUDENT: 'That account is not a student account, so it has no student record to show.',
  NOT_FOUND: 'There is no student with that id.',
  CROSS_TENANT_ACCESS: 'That student belongs to another college.',
  ALREADY_SUSPENDED: 'This student is already suspended. The page below is up to date.',
  NOT_SUSPENDED: 'This student is not suspended any more. The page below is up to date.',
};

export default function StudentDetailPage() {
  const { api } = useApi();
  const { studentId } = useParams<{ studentId: string }>();
  const [data, setData] = useState<AdminStudentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      setData(await api.admin.studentDetail(studentId));
      return true;
    } catch (e) {
      setError(explain(e, REFUSALS));
      return false;
    }
  }, [api, studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Do it, then re-read the student whichever way it went. */
  const change = (request: () => Promise<{ message: string }>) =>
    action.run(async () => {
      setError(null);
      setNotice(null);
      try {
        const result = await request();
        await load();
        setNotice(result.message);
      } catch (e) {
        await load();
        setError(explain(e, REFUSALS));
      }
    });

  return (
    <div className="space-y-4">
      <Link href="/students/find" className="text-sm font-semibold text-[var(--color-accent)] underline">
        ← All students
      </Link>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {!data && !error && <Empty title="Loading…" body="Fetching the student." />}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight">{data.student.name}</h1>
            <AccountPill status={data.student.status} />
          </div>

          {data.suspension && (
            <Banner tone="warn">
              Suspended{data.suspension.suspendedAt ? ` on ${when(data.suspension.suspendedAt)}` : ''}
              {data.suspension.suspendedBy ? ` by ${data.suspension.suspendedBy.name}` : ''}
              {data.suspension.reason ? `: ${data.suspension.reason}` : '. No reason was recorded.'}
            </Banner>
          )}

          <Panel title="Account">
            <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Mobile" value={data.student.mobile} nums />
              <Detail label="Email" value={data.student.email} />
              <Detail label="Mobile verified" value={data.student.mobileVerifiedAt ? when(data.student.mobileVerifiedAt) : 'No'} />
              <Detail label="Joined" value={when(data.student.createdAt)} nums />
              <Detail label="Last signed in" value={data.student.lastLoginAt ? when(data.student.lastLoginAt) : 'Never'} nums />
              {data.profile ? (
                <>
                  <Detail label="Roll number" value={data.profile.rollNumber ?? 'Not given'} nums />
                  <Detail label="Department" value={data.profile.department ?? 'Not given'} />
                  <Detail label="Year" value={data.profile.yearOfStudy ?? 'Not given'} nums />
                  <Detail label="Verification" value={label(VERIFICATION_STATUS, data.profile.verificationStatus)} />
                  <Detail label="Verified on" value={when(data.profile.verifiedAt)} nums />
                  <Detail
                    label="Government ID"
                    value={
                      data.profile.govtIdType
                        ? `${words(data.profile.govtIdType)} ····${data.profile.govtIdLast4 ?? ''}`
                        : 'College ID only'
                    }
                  />
                  <Detail
                    label="Rider terms accepted"
                    value={data.profile.riderTermsAcceptedAt ? when(data.profile.riderTermsAcceptedAt) : 'No'}
                  />
                </>
              ) : (
                <Detail label="Student profile" value="None on file" />
              )}
            </dl>
          </Panel>

          <Panel title="As a rider">
            {data.rider ? (
              <dl className="grid gap-4 p-4 sm:grid-cols-3">
                <Detail label="Work mode" value={data.rider.workModeOn ? 'On' : 'Off'} />
                <Detail label="Delivering now" value={data.rider.activeTaskId ? 'Yes, one delivery in hand' : 'No'} />
                <Detail label="Barred from riding until" value={data.rider.barredUntil ? when(data.rider.barredUntil) : 'Not barred'} />
              </dl>
            ) : (
              <Empty title="Has never ridden" body="This student has not switched work mode on." />
            )}
          </Panel>

          <Panel title="Suspend or reinstate">
            <div className="space-y-3 p-4">
              {data.student.status === 'ACTIVE' && (
                <ReasonAction
                  trigger="Suspend this student…"
                  title={`Suspend ${data.student.name}`}
                  effects={
                    <ul className="list-disc space-y-1 pl-5">
                      <li>They are signed out everywhere at once and cannot sign back in.</li>
                      <li>Work mode is switched off.</li>
                      <li>
                        {data.rider?.activeTaskId
                          ? 'They are delivering something right now: that delivery is taken off them.'
                          : 'Any delivery they are carrying is taken off them.'}
                      </li>
                      <li>You can reinstate them from this page.</li>
                    </ul>
                  }
                  confirmLabel="Confirm: suspend"
                  busy={action.busy}
                  onConfirm={(reason) => void change(() => api.admin.suspendStudent(studentId, reason))}
                />
              )}
              {data.student.status === 'SUSPENDED' && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    tone="approve"
                    loading={action.busy}
                    onClick={() => void change(() => api.admin.reinstateStudent(studentId))}
                  >
                    Reinstate this student
                  </Button>
                  <span className="text-sm text-[var(--color-ink-faint)]">
                    They can sign in again straight away. Work mode stays off until they turn it on.
                  </span>
                </div>
              )}
              {data.student.status === 'DEACTIVATED' && (
                <p className="text-sm text-[var(--color-ink-faint)]">
                  This account has been closed, so there is nothing to suspend or reinstate.
                </p>
              )}
            </div>
          </Panel>

          <Panel title="Verification submissions">
            {data.submissions.length === 0 ? (
              <Empty title="None" body="This student has not submitted an ID for verification." />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {data.submissions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                    <Pill tone={s.status === 'REJECTED' ? 'danger' : s.status === 'PENDING' ? 'pending' : 'ok'}>
                      {label(VERIFICATION_STATUS, s.status)}
                    </Pill>
                    <span className="nums">submitted {when(s.submittedAt)}</span>
                    {s.decidedAt && <span className="nums">decided {when(s.decidedAt)}</span>}
                    {s.rejectionReason && <span>{words(s.rejectionReason)}</span>}
                    {s.rejectionNote && <span className="text-[var(--color-ink-faint)]">{s.rejectionNote}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Recent orders"
            subtitle={`${data.counts.orders} order${data.counts.orders === 1 ? '' : 's'} in all · the latest ${data.recentOrders.length} shown`}
          >
            {data.recentOrders.length === 0 ? (
              <Empty title="No orders" body="This student has not ordered anything." />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {data.recentOrders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <Link href={`/orders/${o.id}`} className="nums font-bold text-[var(--color-accent)] underline">
                      {o.reference}
                    </Link>
                    <OrderStatusPill status={o.status} />
                    <span>{o.shopName}</span>
                    <span className="nums font-semibold">{money(o.totalMinor)}</span>
                    <span className="nums text-[var(--color-ink-faint)]">{when(o.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Recent deliveries and requests"
            subtitle={`${data.counts.tasksRequested} requested · ${data.counts.tasksDelivered} delivered as a rider, in all`}
          >
            {data.recentTasks.length === 0 ? (
              <Empty title="None" body="No deliveries requested or carried." />
            ) : (
              <ul className="divide-y divide-[var(--color-line)] text-sm">
                {data.recentTasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2">
                    <Pill tone={t.role === 'RIDER' ? 'info' : 'plain'}>
                      {t.role === 'RIDER' ? 'as rider' : 'requested'}
                    </Pill>
                    <span className="font-semibold">{label(TASK_TYPE, t.type)}</span>
                    <span>{label(TASK_STATUS, t.status)}</span>
                    <span className="nums">fee {money(t.feeMinor)}</span>
                    <span className="nums text-[var(--color-ink-faint)]">{when(t.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
