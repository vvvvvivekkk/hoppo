import { Stack } from 'expo-router';
import { colour } from '@/lib/theme';

export default function VerifyLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colour.surface },
        headerTintColor: colour.ink,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colour.surfaceSunken },
      }}
    >
      <Stack.Screen name="status" options={{ title: 'Verification' }} />
      <Stack.Screen name="submit" options={{ title: 'Verify your student status' }} />
    </Stack>
  );
}
