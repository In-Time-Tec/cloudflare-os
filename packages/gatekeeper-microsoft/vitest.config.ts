import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/microsoft.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings: {
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
          TENANT_ID: "test-tenant-id",
          VAPID_PUBLIC_KEY: "BJlBeIBRTgG1ekc3TZogaqtrDlyzmkDcRSoF4sd1mS0EUeKthJ57PZsMKSS94DEGhZDsyQmPmwG0U2Iq2czuc5E",
          VAPID_PRIVATE_KEY: "Af5-s42BvXmdApZhvxXQ3_pyH4SUgzs1eW0p5VG2l9Y",
          VAPID_SUBJECT: "mailto:test@example.com",
        },
        durableObjects: {
          TEST_USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          TEST_MAILBOX: { className: "MailboxGatekeeperImpl", useSQLite: true },
          TEST_CALENDAR: { className: "CalendarGatekeeperImpl", useSQLite: true },
          TEST_FILES: { className: "FilesGatekeeperImpl", useSQLite: true },
          TEST_TEAMS: { className: "TeamsGatekeeperImpl", useSQLite: true },
          TEST_CHAT_MIRROR: { className: "ChatMirror", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../test-setup/assert-workerd.ts"],
  },
});
