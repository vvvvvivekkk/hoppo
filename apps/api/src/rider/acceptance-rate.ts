/**
 * FR-TRST-03: a rider's acceptance rate, from the two counters that feed it.
 *
 * Two things make the obvious `accepted / offered` wrong on real rows:
 *
 *  - `tasks_offered` was never incremented before the L5 fix, while
 *    `tasks_accepted` always was. A rider who was active before that fix has
 *    accepted more tasks than the counter says they were offered, and the
 *    plain ratio reports 300%. The rate is therefore clamped: nobody accepts
 *    more than everything.
 *  - With nothing offered there is no rate at all. That is `null`, not 0% —
 *    zero would say "refused every offer" about someone who never had one.
 *
 * Basis points (9500 = 95.00%) because that is what the column stores; an
 * integer, so no float drift.
 */
export function acceptanceRateBps(tasksOffered: number, tasksAccepted: number): number | null {
  if (!Number.isFinite(tasksOffered) || tasksOffered <= 0) return null;

  const accepted = Number.isFinite(tasksAccepted) ? tasksAccepted : 0;
  const bps = Math.round((accepted / tasksOffered) * 10_000);

  return Math.min(10_000, Math.max(0, bps));
}

/** The same rate as a percentage with one decimal place, for display. */
export function acceptanceRatePercent(tasksOffered: number, tasksAccepted: number): number | null {
  const bps = acceptanceRateBps(tasksOffered, tasksAccepted);
  return bps === null ? null : Number((bps / 100).toFixed(1));
}
