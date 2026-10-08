import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/components/app/auth";
import { GateProvider } from "@/components/app/gate";
import { ChainProvider } from "@/components/app/ink/chain-context";
import { initTheme } from "@/lib/theme";

initTheme();

export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <AuthProvider>
            <ChainProvider>
              <GateProvider>
                <StatusBar style="auto" />
                <Stack screenOptions={{ headerShown: false }} />
              </GateProvider>
            </ChainProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
