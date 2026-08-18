import type { RpcStub, RpcTarget } from "cloudflare:workers";

/** A completed Artifact response that should be delivered back to the chat gateway. */
export type ArtifactResponse = {
  text: string;
};

/** RPC target provided by the chat gateway for the backend's eventual response. */
export interface ChatGatewayRpcTarget extends RpcTarget {
  /**
   * Deliver the completed Artifact response. Implementations must be idempotent because delivery is
   * at-least-once when response target acknowledgements fail.
   */
  onArtifactResponse(response: ArtifactResponse): Promise<void>;
}

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = {
  /**
   * Selects the Artifacts account used to submit the message.
   * The backend trusts the gateway: supplying this email grants access as that account.
   */
  callerEmail: string;
  /** Selects the thread to create or reuse. */
  artifactKey: string;
  /** Selects the chat to create or reuse. */
  chatKey: string;
  /** Deduplicates the originating message and correlates the response target. */
  messageKey: string;
  /** Names the thread if it must be created. */
  artifactTitle: string;
  /** User text sent to Artifacts. */
  prompt: string;
  /** Persistent target invoked when the Artifact response is ready. */
  chatGatewayRpcTarget: RpcStub<ChatGatewayRpcTarget>;
};

/** Submission result returned by the backend gateway. */
export type SubmitExternalMessageResult =
  | {
      accepted: true;
      chatPath: string;
    }
  | {
      accepted: false;
      /** User-facing explanation of an actionable submission rejection. */
      message: string;
    };

/** Service binding RPC interface used by chat gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Artifact routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;
}
