import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiProvider } from '@/lib/api';
import { colour } from '@/lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ApiProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colour.surface },
            headerTitleStyle: { fontWeight: '700' },
            headerTintColor: colour.ink,
            contentStyle: { backgroundColor: colour.surfaceSunken },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(verify)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="shop/[listingId]" options={{ title: 'Shop' }} />
          <Stack.Screen name="checkout" options={{ title: 'Checkout' }} />
          <Stack.Screen name="order/[orderId]" options={{ title: 'Order' }} />
          <Stack.Screen name="task/[taskId]" options={{ title: 'Delivery' }} />
        </Stack>
      </ApiProvider>
    </SafeAreaProvider>
  );
}
