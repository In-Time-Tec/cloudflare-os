// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UI_FEATURE_FLAGS,
  type UiFeatureFlags,
} from "@gadgets/workshop-shared/feature-flags";
import { FeatureFlagsProvider, useUiFeatureFlags } from "./FeatureFlagsContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESOLVED_FLAGS = {
  "test-flag": true,
} as unknown as UiFeatureFlags;

const queryState = vi.hoisted(() => ({
  data: undefined as UiFeatureFlags | undefined,
  isPending: true,
}))

vi.mock("./query/hooks", () => ({
  useFeatureFlagsQuery: () => ({ data: queryState.data, isPending: queryState.isPending }),
}))

describe("FeatureFlagsProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    queryState.data = undefined
    queryState.isPending = true
  });

  it("uses defaults while loading then applies resolved flags", async () => {
    let current: ReturnType<typeof useUiFeatureFlags> | undefined;
    function Probe() {
      current = useUiFeatureFlags();
      return null;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => root!.render(
      <QueryClientProvider client={client}>
        <FeatureFlagsProvider><Probe /></FeatureFlagsProvider>
      </QueryClientProvider>,
    ));
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    queryState.data = RESOLVED_FLAGS
    queryState.isPending = false
    await act(async () => root!.render(
      <QueryClientProvider client={client}>
        <FeatureFlagsProvider><Probe /></FeatureFlagsProvider>
      </QueryClientProvider>,
    ));
    expect(current).toEqual({
      flags: { ...DEFAULT_UI_FEATURE_FLAGS, ...RESOLVED_FLAGS },
      loading: false,
    });
  });
});
