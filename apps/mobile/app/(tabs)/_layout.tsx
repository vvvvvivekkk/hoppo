import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { Loading } from '@/components/ui';
import { useApi } from '@/lib/api';
import { colour, text } from '@/lib/theme';

/**
 * UI-1: "a bottom navigation with Home (shops), Orders, Work, Chat, and
 * Community."
 *
 * Chat and Community are Phase 2 and 3, so they are not here — an empty tab
 * is worse than a missing one, because a student taps it and learns the app
 * is unfinished rather than that the feature is coming.
 *
 * Text labels rather than icons. An icon font or asset set is a dependency
 * and a guessing game ("is that a scooter or a bicycle?"); three words are
 * unambiguous and work with a screen reader without extra labelling.
 */
export default function TabsLayout() {
  const { loading, signedIn } = useApi();

  if (loading) return <Loading label="Loading…" />;
  if (!signedIn) return <Redirect href="/(auth)/welcome" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colour.surface },
        headerTitleStyle: { fontWeight: '700' },
        headerTintColor: colour.ink,
        tabBarActiveTintColor: colour.accent,
        tabBarInactiveTintColor: colour.inkFaint,
        tabBarStyle: {
          backgroundColor: colour.surface,
          borderTopColor: colour.line,
          // Comfortably above the 44 px floor, since this is the control used
          // most often and often with a thumb while walking.
          height: 64,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: text.tiny + 1, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Shops',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>◉</Text>,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>▤</Text>,
        }}
      />
      <Tabs.Screen
        name="work"
        options={{
          title: 'Work',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>▲</Text>,
        }}
      />
    </Tabs>
  );
}
