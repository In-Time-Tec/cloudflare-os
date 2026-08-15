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
        },
        durableObjects: {
          TEST_USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          TEST_MAILBOX: { className: "MailboxGatekeeperImpl", useSQLite: true },
          TEST_CALENDAR: { className: "CalendarGatekeeperImpl", useSQLite: true },
          TEST_FILES: { className: "FilesGatekeeperImpl", useSQLite: true },
          TEST_TEAMS: { className: "TeamsGatekeeperImpl", useSQLite: true },
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
