import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Banner, Button, Card, Chip, Heading, Loading } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { colour, space, text } from '@/lib/theme';

interface Status {
  status: 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  latestSubmission: {
    submittedAt: string;
    decidedAt: string | null;
    rejectionReason: string | null;
    rejectionNote: string | null;
  } | null;
  submissionsUsed: number;
  submissionsAllowed: number;
  unlocked: {
    browseShops: boolean;
    placeOrders: boolean;
    workMode: boolean;
    chat: boolean;
    community: boolean;
  };
}

const REASON_TEXT: Record<string, string> = {
  ID_CARD_ILLEGIBLE: 'The photo of your ID card was not readable.',
  ID_CARD_EXPIRED: 'The ID card has expired.',
  NAME_MISMATCH: 'The name does not match the ID card.',
  ROLL_NUMBER_MISMATCH: 'The roll number does not match the ID card.',
  NOT_ENROLLED_AT_COLLEGE: 'We could not confirm you are enrolled at this college.',
  DOCUMENT_INCOMPLETE: 'Part of the document was missing or cut off.',
  SUSPECTED_FORGERY: 'The document could not be accepted.',
  DUPLICATE_ACCOUNT: 'An account already exists for this student.',
  OTHER: 'See the note below.',
};

/**
 * S-08 and S-09: waiting, and being turned down.
 *
 * FR-SVER-06 lets a rejected student resubmit, up to three times in any seven
 * days — so the rejection screen has to say why, say how many attempts are
 * left, and offer the resubmit. A rejection with no reason and no way forward
 * is where someone gives up on the app.
 *
 * The pending screen also lists what *is* available. FR-SVER-01 gives
 * read-only catalog access while waiting, and a student who does not know
 * that just sees a locked app.
 */
export default function VerificationStatus() {
  const { api, logout } = useApi();
  const router = useRouter();
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await api.verification.me();
      setData(result);
      setError(null);
      if (result.status === 'VERIFIED') router.replace('/(tabs)');
    } catch (e) {
      setError(describeError(e));
    }
  }, [api, router]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  if (!data && !error) return <Loading label="Checking your verification…" />;

  const attemptsLeft = data ? data.submissionsAllowed - data.submissionsUsed : 0;

  return (
    <ScrollView
      contentContainerStyle={{ padding: space.xl }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void fetchStatus().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {data?.status === 'PENDING' && (
        <>
          <Heading sub="Usually within a day">Waiting for approval</Heading>
          <Card tone="waiting">
            <Chip tone="waiting">With your campus administrator</Chip>
            <Text style={{ marginTop: space.md, fontSize: text.body, color: colour.inkSoft, lineHeight: 22 }}>
              They check your ID card against the college records. Pull down to refresh, or
              come back later — we will not make you watch this screen.
            </Text>
            {data.latestSubmission ? (
              <Text style={{ marginTop: space.sm, fontSize: text.small, color: colour.inkFaint }}>
                Submitted {new Date(data.latestSubmission.submittedAt).toLocaleString('en-IN')}
              </Text>
            ) : null}
          </Card>
        </>
      )}

      {data?.status === 'REJECTED' && (
        <>
          <Heading sub="You can fix this and try again">Not approved</Heading>
          <Card tone="danger">
            <Chip tone="danger">Rejected</Chip>
            <Text style={{ marginTop: space.md, fontSize: text.body + 1, fontWeight: '600', color: colour.ink }}>
              {REASON_TEXT[data.latestSubmission?.rejectionReason ?? ''] ??
                'Your submission was not accepted.'}
            </Text>
            {data.latestSubmission?.rejectionNote ? (
              <Text style={{ marginTop: space.sm, fontSize: text.body, color: colour.inkSoft, lineHeight: 22 }}>
                {data.latestSubmission.rejectionNote}
              </Text>
            ) : null}
          </Card>

          {/* FR-SVER-06: the limit is real and worth stating plainly, so the
              last attempt is not spent on a blurry photo. */}
          {attemptsLeft > 0 ? (
            <Banner tone="waiting">
              {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left this week. Take the
              photo in good light with the whole card in frame.
            </Banner>
          ) : (
            <Banner tone="danger">
              You have used all {data.submissionsAllowed} attempts for this week. Contact your
              campus administrator.
            </Banner>
          )}

          <Button
            large
            disabled={attemptsLeft <= 0}
            onPress={() => router.push('/(verify)/submit')}
          >
            Try again
          </Button>
        </>
      )}

      {data?.status === 'UNSUBMITTED' && (
        <>
          <Heading sub="One step before you can order or ride">Verify your student status</Heading>
          <Text style={{ fontSize: text.body, color: colour.inkSoft, lineHeight: 22, marginBottom: space.lg }}>
            Your campus administrator checks that you are enrolled, so that everyone ordering
            and delivering is a real student at your college.
          </Text>
          <Button large onPress={() => router.push('/(verify)/submit')}>
            Start
          </Button>
        </>
      )}

      {/* FR-SVER-01: what is open while waiting. Without this the app just
          looks broken to someone who has not been approved yet. */}
      {data && data.status !== 'VERIFIED' && (
        <Card style={{ marginTop: space.xl }}>
          <Text style={{ fontSize: text.body, fontWeight: '700', marginBottom: space.sm }}>
            What you can do meanwhile
          </Text>
          {[
            ['Browse shops and menus', data.unlocked.browseShops],
            ['Place orders', data.unlocked.placeOrders],
            ['Deliver and earn', data.unlocked.workMode],
            ['Message other students', data.unlocked.chat],
          ].map(([label, open]) => (
            <View
              key={String(label)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: text.body, color: open ? colour.good : colour.inkFaint }}>
                {open ? '✓' : '·'}
              </Text>
              <Text style={{ fontSize: text.body, color: open ? colour.ink : colour.inkFaint }}>
                {label}
              </Text>
            </View>
          ))}

          <View style={{ marginTop: space.md }}>
            <Button tone="secondary" onPress={() => router.push('/(tabs)')}>
              Look around the shops
            </Button>
          </View>
        </Card>
      )}

      <View style={{ marginTop: space.xl }}>
        <Button tone="quiet" onPress={() => void logout()}>
          Sign out
        </Button>
      </View>
    </ScrollView>
  );
}
