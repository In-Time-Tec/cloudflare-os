// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_NEW_THREAD_EVENT, type OpenNewThreadDetail } from "./components/AppShell/newThreadBus";

const testClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  navigate: vi.fn<(options: unknown) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    currentUser: { id: "user-a", name: "Dallen Pyrah" },
  }),
}));

vi.mock("./conversations/ConversationsContext", () => ({
  refKey: (ref: { chatId?: string }) => ref.chatId ?? "chat",
  useConversations: () => ({
    emails: [],
    conversations: [],
    available: false,
  }),
}));

vi.mock("./query/conversations", () => ({
  useAgendaQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("./query/hooks", () => ({
  useThreads: () => ({ data: [] }),
}));

vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/_authenticated/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  it("opens the new-thread dialog from a search prompt and does not render a composer", async () => {
    const opened: OpenNewThreadDetail[] = [];
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent<OpenNewThreadDetail>).detail);
    };
    window.addEventListener(OPEN_NEW_THREAD_EVENT, onOpen);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <QueryClientProvider client={testClient}>
        <HomePageContent prompt="Create a daily brief." />
      </QueryClientProvider>,
    ));

    expect(opened).toEqual([{ seed: "Create a daily brief." }]);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("What needs attention, Dallen?");
    expect(container.textContent).toContain("At a glance");
    window.removeEventListener(OPEN_NEW_THREAD_EVENT, onOpen);
  });
});
