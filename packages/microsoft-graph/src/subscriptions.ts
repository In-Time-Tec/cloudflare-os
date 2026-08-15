import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport } from "./transport.js";

// Microsoft Graph change-notification subscriptions for Teams chat/channel messages.
//
// The aggregate all-chats feed (/users/{oid}/chats/getAllMessages) is a beta-track resource this
// deployment deliberately uses without a flag; per-channel subscriptions ride v1.0. Both are
// created against the standard /subscriptions collection. Subscriptions expire after at most
// three days and must be renewed; a lifecycleNotificationUrl receives reauthorizationRequired /
// subscriptionRemoved events between renewals.

const SubscriptionDto = Schema.Struct({
  id: Schema.String,
  resource: Schema.optional(Schema.String),
  expirationDateTime: Schema.optional(Schema.String),
  clientState: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One active Graph subscription. */
export interface GraphSubscription {
  id: string;
  resource: string;
  expires?: Date;
}

/** Teams chat/channel subscriptions max out at 4320 minutes (3 days); renew well before. */
export const MAX_SUBSCRIPTION_MINUTES = 4230;  // slightly under the cap for clock skew

function toSubscription(dto: typeof SubscriptionDto.Type): GraphSubscription {
  return {
    id: dto.id,
    resource: dto.resource ?? "",
    expires: dto.expirationDateTime ? new Date(dto.expirationDateTime) : undefined,
  };
}

function expiry(): string {
  return new Date(Date.now() + MAX_SUBSCRIPTION_MINUTES * 60_000).toISOString();
}

/** What a new subscription listens to and where notifications land. */
export interface SubscriptionInput {
  /** e.g. `/users/{oid}/chats/getAllMessages` or `/teams/{t}/channels/{c}/messages` */
  resource: string;
  notificationUrl: string;
  lifecycleNotificationUrl: string;
  /** Random secret echoed in every notification; the receiver must verify it. */
  clientState: string;
}

/** Create a change-notification subscription (created,updated,deleted). */
export function createSubscription(transport: GraphTransport, input: SubscriptionInput)
    : Effect.Effect<GraphSubscription, GraphError> {
  return Effect.map(
      transport.post(["subscriptions"], {
        changeType: "created,updated,deleted",
        resource: input.resource,
        notificationUrl: input.notificationUrl,
        lifecycleNotificationUrl: input.lifecycleNotificationUrl,
        clientState: input.clientState,
        includeResourceData: false,
        expirationDateTime: expiry(),
      }, SubscriptionDto),
      toSubscription);
}

/** Extend a subscription to the maximum allowed expiry. */
export function renewSubscription(transport: GraphTransport, subscriptionId: string)
    : Effect.Effect<GraphSubscription, GraphError> {
  return Effect.map(
      transport.patch(["subscriptions", subscriptionId],
          { expirationDateTime: expiry() }, SubscriptionDto),
      toSubscription);
}

/** Delete a subscription (best-effort cleanup on disconnect). */
export function deleteSubscription(transport: GraphTransport, subscriptionId: string)
    : Effect.Effect<void, GraphError> {
  return transport.del(["subscriptions", subscriptionId]);
}
