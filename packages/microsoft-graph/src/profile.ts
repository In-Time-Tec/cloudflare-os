import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport } from "./transport.js";

// Directory/profile identity: the minimal read used for account description and identity binding.

const ProfileDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  mail: Schema.optional(Schema.NullOr(Schema.String)),
  userPrincipalName: Schema.optional(Schema.String),
  jobTitle: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The signed-in user's directory profile. `id` is the immutable directory object id (oid). */
export interface UserProfile {
  id: string;
  displayName?: string;
  email?: string;
  jobTitle?: string;
}

/** Fetch the signed-in user's profile. */
export function getProfile(transport: GraphTransport)
    : Effect.Effect<UserProfile, GraphError> {
  return Effect.map(
      transport.get(["me"], ProfileDto, {
        query: { select: ["id", "displayName", "mail", "userPrincipalName", "jobTitle"] },
      }),
      dto => ({
        id: dto.id,
        displayName: dto.displayName ?? undefined,
        email: dto.mail ?? (dto.userPrincipalName?.includes("@")
            ? dto.userPrincipalName : undefined),
        jobTitle: dto.jobTitle ?? undefined,
      }));
}
