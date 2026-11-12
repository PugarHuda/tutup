// E2E against the live deployment (or E2E_BASE). Real chain reads, real APIs; wallet signing is the only thing the
// injected test wallet refuses, to exercise the rejection path. Mainnet transactions are proven in scripts/ and README.
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 25_000 },
  retries: 0,
  workers: 2,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: { baseURL: process.env.E2E_BASE || "https://tutup.vercel.app", trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  projects: [
    { name: "chrome-desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "chrome-mobile", use: { ...devices["Pixel 7"], channel: "chrome" }, grep: /@mobile/ },
    // ponytail: other engines run the route checks only; the wallet/failure flows are engine-independent page logic
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@mobile/ },
    { name: "webkit-iphone", use: { ...devices["iPhone 14"] }, grep: /@mobile/ },
  ],
});
