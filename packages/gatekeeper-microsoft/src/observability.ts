import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Microsoft gatekeeper. */
export type MicrosoftObservabilityFields = {
  vendorId: string;
  closeCode?: string;
  readyState?: number;
};

/** Ambient observability fields for one Microsoft gatekeeper operation. */
export const obsContext = createObservabilityContext<MicrosoftObservabilityFields>();
