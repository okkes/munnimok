const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 20000,       // Babel standalone needs time to compile on first load
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro dimensions
  },
});
