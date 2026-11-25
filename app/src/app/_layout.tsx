import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startSync } from '@/sync/engine';
import { color } from '@/ui/theme';

export default function RootLayout() {
  useEffect(() => { startSync(); }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
