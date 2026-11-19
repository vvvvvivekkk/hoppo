import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { colour, space, text } from '@/lib/theme';

/** S-02 */
export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentContainerStyle={[
        styles.page,
        { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.brand}>Hoppo</Text>
        <Text style={styles.tagline}>
          Order from shops around campus. Deliver between classes and get paid.
        </Text>

        <View style={{ marginTop: space.xxl, gap: space.lg }}>
          {[
            ['Order in minutes', 'From shops verified by your own campus administrator.'],
            [
              'Earn between classes',
              'Turn on work mode when you are free. Turn it off when you are not.',
            ],
            [
              'Only your college',
              'Shops, riders and posts are limited to people at your college.',
            ],
          ].map(([title, body]) => (
            <View key={title}>
              <Text style={styles.pointTitle}>{title}</Text>
              <Text style={styles.pointBody}>{body}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={{ gap: space.md, marginTop: space.xxl }}>
        <Button large onPress={() => router.push('/(auth)/phone')}>
          Get started
        </Button>
        <Button tone="quiet" onPress={() => router.push('/(auth)/login')}>
          I already have an account
        </Button>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: space.xl },
  brand: { fontSize: 44, fontWeight: '900', color: colour.accent, letterSpacing: -1.5 },
  tagline: { fontSize: text.title, color: colour.inkSoft, marginTop: space.sm, lineHeight: 30 },
  pointTitle: { fontSize: text.body + 2, fontWeight: '700', color: colour.ink },
  pointBody: { fontSize: text.body, color: colour.inkFaint, marginTop: 2, lineHeight: 22 },
});
