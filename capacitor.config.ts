import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bmgfleet.fleetsuite',
  appName: 'BMG FleetSuite',
  // Load from the live production site — updates deploy instantly
  // without app store submissions
  server: {
    url: 'https://go.bmgfleet.com',
    cleartext: false,
  },
  // Native plugin configuration
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#0f1720',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f1720',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  // iOS-specific
  ios: {
    scheme: 'BMG FleetSuite',
    backgroundColor: '#0f1720',
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    allowsLinkPreview: false,
  },
  // Android-specific
  android: {
    backgroundColor: '#0f1720',
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
