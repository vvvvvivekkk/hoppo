import { Stack } from 'expo-router';
import { colour } from '@/lib/theme';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colour.surface },
        headerTintColor: colour.ink,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colour.surface },
      }}
    >
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="phone" options={{ title: 'Your mobile number' }} />
      <Stack.Screen name="profile" options={{ title: 'Create your account' }} />
      <Stack.Screen name="login" options={{ title: 'Log in' }} />
    </Stack>
  );
}
