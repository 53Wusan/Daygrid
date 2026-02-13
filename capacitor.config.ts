import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'wusan.daygrid',
  appName: 'DayGrid',
  webDir: 'dist',
  plugins: {
    StatusBar: {
      overlaysWebView: false,
    },
  },
};

export default config;
