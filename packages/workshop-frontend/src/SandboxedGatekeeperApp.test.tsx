// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const THREAD_ID = "a".repeat(64);

const listThreads = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: THREAD_ID, title: "Daily Brief" },
]);
const authenticatedApi = { listThreads };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openThread(threadId: string, gadgetId?: number): Promise<void>;
  resolveThreadTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
}

class EmptyUi extends RpcTarget {}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listThreads.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/thread/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });

    await act(async () => {
      await host!.openThread(THREAD_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/thread/${THREAD_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listThreads
      .mockResolvedValueOnce([{ id: THREAD_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: THREAD_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveThreadTitles([THREAD_ID, "b".repeat(64)]),
        host.resolveThreadTitles([THREAD_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveThreadTitles([THREAD_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listThreads).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveThreadTitles([THREAD_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listThreads).toHaveBeenCalledTimes(2);

    await expect(host.openThread("../evil")).rejects.toThrow(
      "Invalid gatekeeper app thread target",
    );
    expect(router.state.location.pathname).toBe(`/thread/${THREAD_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });

  it("rebuilds srcDoc when the gatekeeper app id changes", async () => {
    const { persistGatekeeperAppSnapshot } = await import("./query/gatekeeper-app");
    await persistGatekeeperAppSnapshot("scheduler", { schedules: [{ title: "Morning brief" }] });
    await persistGatekeeperAppSnapshot("context", { enabled: [{ title: "Handbook" }] });

    const scheduler = {
      iframeHtml: "<!doctype html><html><head></head><body>Scheduler</body></html>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const context = {
      iframeHtml: "<!doctype html><html><head></head><body>Context</body></html>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;

    function Harness() {
      const [id, setId] = useState<"scheduler" | "context">("scheduler");
      return (
        <>
          <button type="button" onClick={() => setId("context")}>
            next
          </button>
          <SandboxedGatekeeperApp
            frame={id === "scheduler" ? scheduler : context}
            gatekeeperVendorId={id}
          />
        </>
      );
    }

    const rootRoute = createRootRoute({
      component: Harness,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([indexRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Morning brief");

    await act(async () => {
      container!.querySelector("button")!.click();
    });
    const srcDoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Handbook");
    expect(srcDoc).toContain("Context");
    expect(srcDoc).not.toContain("Morning brief");
  });
});
