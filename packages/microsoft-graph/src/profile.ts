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

/** Cap for profile photos; Graph's 48x48 variant is a few KB. */
export const MAX_PHOTO_BYTES = 128 * 1024;

/**
 * Fetch a user's 48x48 profile photo as raw bytes, or null when the user has none (404).
 * Requires User.ReadBasic.All for other users.
 */
export function getUserPhoto(transport: GraphTransport, userId: string)
    : Effect.Effect<Uint8Array | null, GraphError> {
  return transport.getBytes(["users", userId, "photos", "48x48", "$value"], MAX_PHOTO_BYTES).pipe(
      Effect.map((bytes): Uint8Array | null => bytes),
      Effect.catchTag("GraphNotFoundError", () => Effect.succeed(null)));
}
