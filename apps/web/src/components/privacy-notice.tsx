'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, type PrivacyNotice } from '@hoppo/api-client';
import { Banner, Button, Card } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * The privacy notice (FR-PRIV-01), fetched from the API rather than written
 * into this app.
 *
 * The API owns the text and its version, and records which version each
 * person accepted. A copy kept here would drift from that the first time the
 * notice was revised, and a student would be agreeing to words the server
 * never showed them. So every screen that shows the notice — registration,
 * the legal page, the delete-account confirmation — reads this one source.
 *
 * The route is public: the notice has to be readable before there is an
 * account to read it with.
 */
export function usePrivacyNotice(enabled = true): {
  notice: PrivacyNotice | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const { api } = useApi();
  const [notice, setNotice] = useState<PrivacyNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotice(await api.privacy.notice());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { notice, error, loading, reload: () => void load() };
}

/**
 * The notice's four sections and the grievance contact, in the API's order.
 *
 * FR-PRIV-01 names exactly these: what is collected, why, for how long, and
 * who to complain to. They are all shown, in full — a notice the student has
 * to tap through to read is not one that was presented.
 */
export function PrivacyNoticeBody({ notice }: { notice: PrivacyNotice }) {
  const { name, email } = notice.grievanceContact;

  return (
    <div className="space-y-3 text-sm">
      {notice.sections.map((section) => (
        <section key={section.key}>
          <h3 className="font-bold">{section.heading}</h3>
          <p className="mt-0.5 text-[var(--color-ink-soft)]">{section.body}</p>
        </section>
      ))}
      {/* Only when the deployment has one configured. The grievance section
          above still says what to do; inventing a contact would be worse
          than showing none. */}
      {(name || email) && (
        <p className="text-[var(--color-ink-soft)]">
          Grievance contact: {name}
          {name && email ? ', ' : ''}
          {email && (
            <a href={`mailto:${email}`} className="text-[var(--color-accent)] underline">
              {email}
            </a>
          )}
        </p>
      )}
      <p className="text-[var(--color-ink-faint)]">
        Version {notice.version}, in effect from{' '}
        {new Date(notice.effectiveFrom).toLocaleDateString('en-IN', { dateStyle: 'medium' })}.
      </p>
    </div>
  );
}

/**
 * Where a signed-in person stands on the current notice, with a way to accept
 * it if they have not.
 *
 * An invitation, not a gate. Accounts made before the notice existed have no
 * acceptance on record, and a revised notice leaves everyone on the old
 * version; the API refuses nobody for either, so this does not block anything
 * or nag — it states the fact and offers one button.
 *
 * The version sent is the one on screen. If the notice was revised in the
 * moment between showing it and tapping, the API answers
 * `PRIVACY_NOTICE_OUTDATED`; the new text is then loaded and the person is
 * asked again, because accepting words they were not shown is not accepting.
 */
export function PrivacyAcceptance({
  notice,
  onOutdated,
}: {
  notice: PrivacyNotice;
  /** Reload the notice: the one on screen is no longer current. */
  onOutdated: () => void;
}) {
  const { api, user, adoptUser } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const accepted = user.privacyNotice ?? null;
  const current = accepted?.version === notice.version;

  async function accept() {
    if (!user) return;
    setBusy(true);
    setError(null);

    try {
      const acceptance = await api.privacy.accept(notice.version);
      // The response is the new acceptance; put it on the user in context
      // rather than fetching the whole account again to learn the same thing.
      adoptUser({ ...user, privacyNotice: acceptance });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRIVACY_NOTICE_OUTDATED') {
        setError(
          'The privacy notice was updated just now. The new version is being loaded — read it, then accept.',
        );
        onOutdated();
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (current && accepted) {
    return (
      <Banner tone="info">
        You accepted this version on{' '}
        {new Date(accepted.acceptedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}.
      </Banner>
    );
  }

  return (
    <Card tone="waiting" className="p-4">
      <p className="font-semibold">
        {accepted
          ? `You accepted an earlier version (${accepted.version}). This is the current one.`
          : 'There is no acceptance of this notice on record for your account.'}
      </p>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        Nothing stops working if you do not accept it. Accepting records that you have read version{' '}
        {notice.version}.
      </p>
      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <Button className="mt-3 w-full" loading={busy} onClick={() => void accept()}>
        Accept the privacy notice
      </Button>
    </Card>
  );
}
