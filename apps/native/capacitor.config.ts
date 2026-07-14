import type { CapacitorConfig } from '@capacitor/cli';

// The shell ships the BUILT web bundle inside the binary (no remote
// webview): offline-first stays true and a build is reproducible from
// a git tag (docs/native-apps-design.md).
const config: CapacitorConfig = {
  appId: 'app.munni',
  appName: 'munni',
  webDir: '../web/dist',
  android: {
    // munni handles its own safe areas via CSS env()
    adjustMarginsForEdgeToEdge: 'disable',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
