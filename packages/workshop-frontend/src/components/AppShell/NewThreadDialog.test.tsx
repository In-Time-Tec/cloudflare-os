// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNewThread } from "./newThreadBus";

const testState = vi.hoisted(() => ({
  drafts: [] as Array<string | undefined>,
  seeds: [] as Array<{ text?: string; nonce?: number }>,
  navigate: vi.fn<(options: unknown) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: vi.fn() }),
}));

vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: { newThread: vi.fn() },
    currentUser: { id: "user-a", name: "Dallen Pyrah" },
  }),
}));

vi.mock("../../query/hooks", () => ({
  useModels: () => ({ data: [] }),
}));

vi.mock("../../ChatInterface", () => ({
  ChatInput: ({ seedText, seedNonce, draftStorageKey, dialog }: {
    seedText?: string
    seedNonce?: number
    draftStorageKey?: string
    dialog?: boolean
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.drafts.push(draftStorageKey);
    return <textarea aria-label="Prompt" readOnly value={dialog ? "Write prompt..." : seedText ?? ""} />;
  },
}));

import NewThreadDialog from "./NewThreadDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("NewThreadDialog", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    testState.seeds.length = 0;
    testState.drafts.length = 0;
    vi.clearAllMocks();
  });

  it("opens from the bus, seeds the composer, and keeps the home draft key", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<NewThreadDialog />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      openNewThread({ seed: "Build a dark calculator." });
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("Close");
    expect(testState.seeds.at(-1)).toMatchObject({ text: "Build a dark calculator." });
    expect(testState.drafts).toContain("gadgets:composer-draft:v1:user-a:home");
  });
});
