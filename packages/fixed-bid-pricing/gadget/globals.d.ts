declare const gadget: {
  getEstimate(): Promise<unknown>;
  updateEstimate(input: unknown): Promise<unknown>;
  proposeChanges(input: unknown): Promise<unknown>;
  approveProposal(input: unknown): Promise<unknown>;
  rejectProposal(input: unknown): Promise<unknown>;
  subscribe(callback: RpcTarget): Promise<unknown>;
};

declare class RpcTarget {
  [Symbol.dispose](): void;
}

declare module "cloudflare:workers" {
  export const DurableObject: new (state: unknown, env: unknown) => object;
}
