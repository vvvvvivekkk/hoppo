'use client';

import { useState } from 'react';
import { ApiError, type AccountDeletion } from '@hoppo/api-client';
import { Banner, Button, Card, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { usePrivacyNotice } from '@/components/privacy-notice';

/**
 * S-55, FR-PRIV-05: download my data, delete my account.
 *
 * Both act on the signed-in account and nothing else — neither request
 * carries an id, so there is nothing here that could be pointed at somebody
 * else's data.
 *
 * Deleting is the one action in this app that cannot be undone, so it is two
 * steps and a password, and the second step says what will happen in the
 * API's own words rather than in a paraphrase kept here: the retention
 * section of the privacy notice is the statement the server is held to. When
 * the API refuses — a delivery or order still open, money in the wallet, a
 * withdrawal not yet paid — its sentence is shown as it came, because each
 * one already says what to do about it.
 */
export function AccountData({ onDeleted }: { onDeleted: (result: AccountDeletion) => void }) {
  const { api } = useApi();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Only fetched once the student opens the confirmation.
  const privacy = usePrivacyNotice(confirming);
  const retention = privacy.notice?.sections.find((s) => s.key === 'retention');

  async function downloadData() {
    setExporting(true);
    setExportError(null);
    setExported(false);

    try {
      const data = await api.account.export();

      // Built here, in the browser: the API returns the data as JSON and this
      // turns it into a file. It never passes through anywhere else.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hoppo-my-data-${data.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setExported(true);
    } catch (e) {
      // The generic rate-limit wording says "wait a moment", which is wrong
      // here: this limit is counted per hour.
      setExportError(
        e instanceof ApiError && e.isRateLimited
          ? 'You have downloaded your data several times in the last hour. Try again later.'
          : describeError(e),
      );
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    setDeleting(true);
    setDeleteError(null);

    try {
      onDeleted(await api.account.delete(password));
    } catch (e) {
      // ACTIVE_TASK_IN_PROGRESS, WALLET_BALANCE_NOT_ZERO, WITHDRAWAL_PENDING,
      // PASSWORD_INCORRECT: each message already says what is in the way.
      setDeleteError(describeError(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="mt-3 p-5">
      <p className="font-bold">Your data</p>

      <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
        A file with everything Hoppo holds about you: your account and college details, your
        verification history, orders, deliveries and wallet entries. It does not include photos of
        your ID, or anybody else&apos;s name.
      </p>
      {exportError && (
        <div className="mt-3">
          <Banner tone="error">{exportError}</Banner>
        </div>
      )}
      {exported && (
        <div className="mt-3">
          <Banner tone="success">
            Your data was downloaded as a JSON file. Check your downloads folder.
          </Banner>
        </div>
      )}
      <Button
        tone="secondary"
        className="mt-3 w-full"
        loading={exporting}
        onClick={() => void downloadData()}
      >
        Download my data
      </Button>

      <div className="mt-5 border-t border-[var(--color-line)] pt-4">
        {!confirming ? (
          <Button tone="quiet" className="w-full" onClick={() => setConfirming(true)}>
            Delete my account
          </Button>
        ) : (
          <form onSubmit={deleteAccount}>
            <p className="font-semibold text-[var(--color-danger)]">Delete your account?</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              This cannot be undone. You are signed out on every device and cannot sign in again
              with this account.
            </p>

            {/* What is erased and what is kept, from the notice the server
                is held to, not from a summary written here. */}
            {retention ? (
              <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{retention.body}</p>
            ) : (
              <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                {privacy.error
                  ? 'The privacy notice, which sets out what is erased and what is kept, could not be loaded just now. You can read it under Legal before deciding.'
                  : 'Loading what is erased and what is kept…'}
              </p>
            )}

            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              It is refused while you have an order or delivery in progress, while your wallet holds
              money, or while a withdrawal is waiting to be paid. If so, you will be told which.
            </p>

            {deleteError && (
              <div className="mt-3">
                <Banner tone="error">{deleteError}</Banner>
              </div>
            )}

            <div className="mt-3">
              <Field
                label="Your password, to confirm"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <div className="mt-3 flex gap-2">
              <Button
                type="submit"
                tone="danger"
                className="flex-1"
                loading={deleting}
                disabled={password.length === 0}
              >
                Delete it for good
              </Button>
              <Button
                type="button"
                tone="secondary"
                className="flex-1"
                onClick={() => {
                  setConfirming(false);
                  setPassword('');
                  setDeleteError(null);
                }}
              >
                Keep my account
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
