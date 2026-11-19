import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { Loading } from '@/components/ui';
import { useApi } from '@/lib/api';

/**
 * S-01: the auth gate.
 *
 * Four outcomes, and the order matters. A student whose verification was
 * rejected must land on the screen that tells them why and lets them
 * resubmit (S-09) rather than on the home screen with features quietly
 * missing — FR-SVER-06 gives them three attempts and they need to know.
 *
 * An *unverified* student does go to the home screen, because FR-SVER-01
 * gives them read-only catalog access, and an app that shows nothing while
 * they wait for an administrator is a worse first impression than one that
 * lets them look around.
 */
export default function Gate() {
  const { loading, signedIn, user } = useApi();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Loading label="Starting up…" />
      </View>
    );
  }

  if (!signedIn) return <Redirect href="/(auth)/welcome" />;

  const status = user?.studentProfile?.verificationStatus;

  // Nothing submitted yet, or a rejection to deal with: both need the
  // verification flow rather than the home screen.
  if (status === 'UNSUBMITTED' || status === 'REJECTED') {
    return <Redirect href="/(verify)/status" />;
  }

  return <Redirect href="/(tabs)" />;
}
