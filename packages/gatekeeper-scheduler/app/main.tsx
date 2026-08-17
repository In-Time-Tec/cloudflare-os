import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SchedulerPage, {
  type ScheduleManagementClient,
  type SchedulerSnapshot,
} from "./SchedulerPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ScheduleManagementClient>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
  readPersistedSnapshot(): Promise<SchedulerSnapshot | null>;
  writePersistedSnapshot(data: SchedulerSnapshot): Promise<void>;
  writePersistedPaint(html: string): Promise<void>;
}

function readBootSnapshot(): SchedulerSnapshot | undefined {
  return (window as Window & { __GADGETS_PERSISTED__?: SchedulerSnapshot }).__GADGETS_PERSISTED__;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Scheduler app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host
    .subscribeTheme(iframe)
    .then(applyAppTheme)
    .catch(() => {});

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("scheduler.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      <SchedulerPage
        api={host.ui}
        openWorkspace={(workspaceId, gadgetId) => host.openWorkspace(workspaceId, gadgetId)}
        resolveWorkspaceTitles={(ids) => host.resolveWorkspaceTitles(ids)}
        openPrompt={(prompt) => host.openPrompt(prompt)}
        persistSnapshot={(snapshot) => host.writePersistedSnapshot(snapshot)}
        persistPaint={() => {
          const root = document.getElementById("root");
          if (root) void host.writePersistedPaint(root.innerHTML);
        }}
        initialSnapshot={readBootSnapshot()}
      />
    </ErrorBoundary>,
  );
}

main();
