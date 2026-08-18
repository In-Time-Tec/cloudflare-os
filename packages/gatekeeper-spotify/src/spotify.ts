import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import {
  ActionCapability,
  ActionKind,
  ActionRecorder,
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription, AuthenticatedIdentity,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  SpotifyApi,
  SpotifyApiError,
  exchangeAuthCode,
  refreshAccessToken,
  type SpotifyAlbumResponse,
  type SpotifyArtistResponse,
  type SpotifyDeviceResponse,
  type SpotifyPlaybackStateResponse,
  type SpotifyPlaylistResponse,
  type SpotifyTrackResponse,
  type SpotifyUserResponse,
} from "./spotify-api";
import type {
  SpotifyAccountSession,
  SpotifyAlbumRef,
  SpotifyArtistRef,
  SpotifyDevice,
  SpotifyImage,
  SpotifyPlaybackState,
  SpotifyPlayHistoryEntry,
  SpotifyPlayer,
  SpotifyPlaylist,
  SpotifyPlaylistSummary,
  SpotifyPlaylistTrack,
  SpotifyPlayOptions,
  SpotifyProfile,
  SpotifyRepeatMode,
  SpotifySearchResults,
  SpotifySearchType,
  SpotifyTopTimeRange,
  SpotifyTrack,
  SpotifyUserRef,
  SpotifyPlaylistDetailsUpdate,
} from "./types";
import TYPES_CODE from "./types.txt";
import SPOTIFY_LOGO_SVG from "./spotify-logo.svg";
import SPOTIFY_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import SPOTIFY_PLAYLIST_CONFIGURATOR_HTML from "./generated/playlist-configurator-ui.txt";
import type { SpotifyAccountConfiguratorRpc } from "./configurator/account-configurator-types";
import type {
  SpotifyConfiguratorOption,
  SpotifyPlaylistConfiguratorRpc,
} from "./configurator/playlist-configurator-types";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type ResourceKind = "account" | "playlist";

type SpotifyGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  playlistId?: string;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

// Scopes requested during connect — broad enough to cover both resource granularities.
const OAUTH_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played",
  "user-follow-read",
  "user-follow-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
];



const SPOTIFY_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SPOTIFY_LOGO_SVG)}`;

const ACCOUNT_RESOURCE: SupportedResource = {
  // Whole-instance catch-all (matches any URL), like other single-tenant gatekeepers.
  urlPattern: "https://*",
  title: "Spotify Account",
  description:
    "Whole-account access: profile, catalog search, your library, your playlists, and playback control.",
  icon: { url: SPOTIFY_LOGO_URL },
};

const PLAYLIST_RESOURCE: SupportedResource = {
  urlPattern: "https://open.spotify.com/playlist/:playlistId",
  title: "Spotify Playlist",
  description: "Read and edit a single Spotify playlist.",
  icon: { url: SPOTIFY_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE, PLAYLIST_RESOURCE];

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1DB954; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #1DB954; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1DB954; font-size: 1.5rem; margin: 0 0 1rem 0;">Spotify Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a Spotify OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // The early length-mismatch return isn't a timing leak here: both values are fixed-length random
  // hex nonces, so length carries no secret. timingSafeEqual also requires equal-length inputs.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/spotify");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function ensureConfigured(env: Env): asserts env is Env & { CLIENT_ID: string; CLIENT_SECRET: string } {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The Spotify gatekeeper is not configured.");
  }
}

// Extract a playlist ID from an open.spotify.com URL, a spotify:playlist:ID URI, or a bare ID.
function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(trimmed);
  if (uriMatch) return uriMatch[1];
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("playlist");
    if (idx >= 0 && segments[idx + 1]) return segments[idx + 1];
  } catch {
    // not a URL
  }
  return null;
}

function profileUrl(userId: string): string {
  return `https://open.spotify.com/user/${userId}`;
}

function playlistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

// ---------------------------------------------------------------------------
// Normalizers: raw Spotify responses -> the shapes declared in types.d.ts.

function normalizeImages(
  images: { url: string; width?: number | null; height?: number | null }[] | null | undefined,
): SpotifyImage[] {
  return (images ?? []).map(image => ({
    url: image.url,
    width: image.width ?? null,
    height: image.height ?? null,
  }));
}

function externalUrl(value: { external_urls?: { spotify?: string } }, fallback: string): string {
  return value.external_urls?.spotify ?? fallback;
}

function normalizeArtistRef(artist: SpotifyArtistResponse): SpotifyArtistRef {
  return {
    id: artist.id,
    name: artist.name,
    uri: artist.uri,
    url: externalUrl(artist, `https://open.spotify.com/artist/${artist.id}`),
  };
}

function normalizeAlbumRef(album: SpotifyAlbumResponse): SpotifyAlbumRef {
  return {
    id: album.id,
    name: album.name,
    uri: album.uri,
    url: externalUrl(album, `https://open.spotify.com/album/${album.id}`),
    albumType: album.album_type ?? "album",
    releaseDate: album.release_date ?? "",
    totalTracks: album.total_tracks ?? 0,
    images: normalizeImages(album.images),
    artists: (album.artists ?? []).map(normalizeArtistRef),
  };
}

function normalizeUserRef(user: SpotifyUserResponse): SpotifyUserRef {
  return {
    id: user.id,
    displayName: user.display_name ?? null,
    uri: user.uri,
    url: externalUrl(user, profileUrl(user.id)),
  };
}

function normalizeTrack(track: SpotifyTrackResponse): SpotifyTrack {
  return {
    id: track.id,
    name: track.name,
    uri: track.uri,
    url: externalUrl(track, `https://open.spotify.com/track/${track.id}`),
    artists: (track.artists ?? []).map(normalizeArtistRef),
    album: normalizeAlbumRef(track.album),
    durationMs: track.duration_ms,
    explicit: track.explicit,
    popularity: track.popularity ?? null,
    discNumber: track.disc_number ?? 1,
    trackNumber: track.track_number ?? 0,
    isLocal: track.is_local ?? false,
  };
}

function normalizeProfile(user: SpotifyUserResponse): SpotifyProfile {
  return {
    id: user.id,
    displayName: user.display_name ?? null,
    email: user.email ?? null,
    product: user.product ?? null,
    country: user.country ?? null,
    followerCount: user.followers?.total ?? 0,
    uri: user.uri,
    url: externalUrl(user, profileUrl(user.id)),
    images: normalizeImages(user.images),
  };
}

function normalizePlaylistSummary(playlist: SpotifyPlaylistResponse): SpotifyPlaylistSummary {
  return {
    id: playlist.id,
    name: playlist.name,
    uri: playlist.uri,
    url: externalUrl(playlist, playlistUrl(playlist.id)),
    description: playlist.description ?? null,
    owner: normalizeUserRef(playlist.owner),
    public: playlist.public ?? null,
    collaborative: playlist.collaborative ?? false,
    // Feb 2026 renamed `tracks` -> `items`; for playlists the user doesn't own the count container
    // may be absent entirely, in which case this is 0 (contents are withheld by Spotify).
    trackCount: playlist.items?.total ?? playlist.tracks?.total ?? 0,
    images: normalizeImages(playlist.images),
    snapshotId: playlist.snapshot_id,
  };
}

function normalizeDevice(device: SpotifyDeviceResponse): SpotifyDevice {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    isActive: device.is_active,
    volumePercent: device.volume_percent,
    supportsVolume: device.supports_volume ?? device.volume_percent !== null,
  };
}

function normalizeRepeat(state?: string): SpotifyRepeatMode {
  return state === "track" || state === "context" ? state : "off";
}

function normalizePlaybackState(state: SpotifyPlaybackStateResponse | undefined): SpotifyPlaybackState {
  if (!state) {
    return {
      isPlaying: false,
      device: null,
      track: null,
      progressMs: null,
      shuffle: false,
      repeat: "off",
      contextUri: null,
    };
  }
  return {
    isPlaying: state.is_playing,
    device: state.device ? normalizeDevice(state.device) : null,
    track: state.item ? normalizeTrack(state.item) : null,
    progressMs: state.progress_ms ?? null,
    shuffle: state.shuffle_state ?? false,
    repeat: normalizeRepeat(state.repeat_state),
    contextUri: state.context?.uri ?? null,
  };
}

// Validate a caller-supplied limit (Spotify's minimum is 1). Throws on invalid input — consistent
// with clampOffset — and clamps down to the per-endpoint max. `undefined` uses the default.
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  return Math.min(limit, max);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer.");
  }
  return offset;
}

function normalizeTimeRange(range: SpotifyTopTimeRange | undefined): string {
  return range === "short_term" || range === "long_term" ? range : "medium_term";
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Auth initiation: /<doId>/<initiationNonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const redirectUrl = new URL("https://accounts.spotify.com/authorize");
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", begun.scopes.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("Spotify authorization failed or was denied. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const accepted = await stub.acceptAuthCode(code, oauthNonce);
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Spotify",
      url: "https://www.spotify.com",
      logo: { url: SPOTIFY_LOGO_URL },
      color: "#1DB954",
      tagline: "Manage playlists, your library, and playback",
      description:
        "Connect your Spotify account so Cloudflare OS can search the catalog, read and edit your " +
        "library and playlists, and control playback on your devices. Grant whole-account access " +
        "or scope a Gadget to a single playlist.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores OAuth credentials and refreshes access tokens.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { oauthNonce, scopes: OAUTH_SCOPES };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, `${getBaseUrl(this.env)}/oauth`);
    if (!grant.refreshToken) {
      throw new Error("Spotify did not return a refresh token.");
    }

    this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    this.ctx.storage.kv.put("scopes", grant.scopes);
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("accessToken");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (token && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) {
      return token;
    }

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("Spotify credentials have not been configured for this account.");
    }
    ensureConfigured(this.env);

    let grant;
    try {
      grant = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    } catch (err) {
      if (err instanceof SpotifyApiError && (err.isAuthError || err.status === 400)) {
        await this.noteCredentialsExpired();
      }
      throw err;
    }

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("scopes", grant.scopes);
    return grant.accessToken;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Spotify exposes no token-revocation endpoint; drop the local credentials. The user can
    // revoke the app's access from their Spotify account settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: SpotifyApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new SpotifyApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Spotify credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const user = await api.getCurrentUser();
      return {
        displayName: user.display_name ?? user.id,
        uniqueName: user.id,
        avatar: { url: user.images?.[0]?.url ?? "" },
      };
    });
  }

  /** Spotify is not offered as a sign-in identity provider (no verified-email flag exposed). */
  async getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const playlistId = parsePlaylistId(url);
    if (playlistId) {
      const props: SpotifyGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "playlist",
        playlistId,
      };
      return { class: this.ctx.exports.SpotifyGatekeeperImpl({ props }), resource: PLAYLIST_RESOURCE };
    }

    // Any other URL is whole-account access against the connected account.
    const props: SpotifyGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      resourceKind: "account",
    };
    return { class: this.ctx.exports.SpotifyGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const getToken = async () => await this.#userAccount().getAccessToken();

    if (resourceUrlPattern === ACCOUNT_RESOURCE.urlPattern) {
      return {
        iframeHtml: SPOTIFY_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new SpotifyAccountConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === PLAYLIST_RESOURCE.urlPattern) {
      return {
        iframeHtml: SPOTIFY_PLAYLIST_CONFIGURATOR_HTML,
        ui: new RpcStub(new SpotifyPlaylistConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Spotify resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account. Spotify uses the "low-stakes" observer strategy (see
   * SpotifyGatekeeperImpl.addObserver): a personal Spotify account is not the kind of restricted
   * corporate data the information-flow model is designed to protect, so any collaborator may
   * observe. The verifier therefore carries no identity and is never consulted — but the overseer
   * mints one on every open, so it must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SpotifyVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// A trivial verifier since Spotify's observer strategy is low-stakes.
@validateRpc()
export class SpotifyVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Action model and caching.
//
// Every write is authorized, performed against Spotify, and its outcome reported, before the
// calling method returns.

type WithApi = <T>(fn: (api: SpotifyApi) => Promise<T>) => Promise<T>;

type PlayerCommand =
  | { op: "play"; deviceId?: string; body: Record<string, unknown> }
  | { op: "pause"; deviceId?: string }
  | { op: "next"; deviceId?: string }
  | { op: "previous"; deviceId?: string }
  | { op: "seek"; positionMs: number; deviceId?: string }
  | { op: "setVolume"; volumePercent: number; deviceId?: string }
  | { op: "setShuffle"; shuffle: boolean; deviceId?: string }
  | { op: "setRepeat"; mode: SpotifyRepeatMode; deviceId?: string }
  | { op: "transfer"; deviceId: string; play: boolean }
  | { op: "addToQueue"; uri: string; deviceId?: string };

// ---------------------------------------------------------------------------
// Action kinds
//
// Playback control and library/playlist edits are separated because they carry different risk:
// playback is momentary and private, while a playlist edit changes durable state that anyone the
// playlist is shared with can see.

const PLAYBACK_CONTROL: ActionKind = {
  tag: "spotify.playback.control", label: "Control playback",
};
const LIBRARY_EDIT: ActionKind = {
  tag: "spotify.library.edit", label: "Save or remove library items",
};
const PLAYLIST_CREATE: ActionKind = { tag: "spotify.playlist.create", label: "Create a playlist" };
const PLAYLIST_EDIT: ActionKind = {
  tag: "spotify.playlist.edit", label: "Change a playlist's tracks or details",
};
const PLAYLIST_LIBRARY: ActionKind = {
  tag: "spotify.playlist.library", label: "Follow or unfollow a playlist",
};

/** Every side-effecting operation this gatekeeper performs, for consent and deployment policy. */
const ACTION_CATALOG: ActionCapability[] = [
  {
    kind: PLAYBACK_CONTROL,
    summary: "Start, pause, skip, seek, and otherwise steer playback on your devices",
    risk: {
      // Playback state is transient: the opposite command restores it.
      reversible: "automatic",
      reach: "acts-on-world",
      audience: "private",
      freeform: false,
    },
  },
  {
    kind: LIBRARY_EDIT,
    summary: "Save or remove tracks and albums, and follow or unfollow artists",
    risk: {
      reversible: "automatic",
      reach: "modifies-content",
      // Followed artists are public on a Spotify profile by default.
      audience: "shared",
      freeform: false,
    },
  },
  {
    kind: PLAYLIST_CREATE,
    summary: "Create a playlist, with a name and description you supply",
    risk: {
      // Deleting a playlist on Spotify means unfollowing it, which a person does.
      reversible: "manual",
      reach: "creates-content",
      audience: "shared",
      freeform: true,
    },
  },
  {
    kind: PLAYLIST_EDIT,
    summary: "Add, remove, reorder, or replace a playlist's tracks, or change its name, description, or visibility",
    risk: {
      reversible: "manual",
      reach: "modifies-content",
      // A collaborative or public playlist is visible beyond its owner.
      audience: "shared",
      // The name and description are free text.
      freeform: true,
    },
  },
  {
    kind: PLAYLIST_LIBRARY,
    summary: "Add a playlist to your library, or remove one (which deletes a playlist you own)",
    risk: {
      reversible: "manual",
      reach: "modifies-content",
      audience: "private",
      freeform: false,
    },
  },
];

// A track as it sits in a playlist.
type PlaylistDetailsCache = { fetchedAt: number; summary: SpotifyPlaylistSummary };

const PLAYLIST_CACHE_TTL_MS = 15 * 1000;
const PLAYLIST_WRITE_CHUNK = 100;

const trackUri = (id: string) => `spotify:track:${id}`;
const albumUri = (id: string) => `spotify:album:${id}`;
const artistUri = (id: string) => `spotify:artist:${id}`;
const playlistUri = (id: string) => `spotify:playlist:${id}`;

// Extract a Spotify id from a bare id, a "spotify:<kind>:<id>" URI, or an open.spotify.com URL.
// Returns null if unrecognizable. Spotify ids are 22-char base62, so a bare value must match that
// to catch obviously-bogus input early.
function extractSpotifyId(input: string, kind: "track" | "album" | "artist" | "playlist"): string | null {
  const trimmed = input.trim();
  const uriMatch = new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`).exec(trimmed);
  if (uriMatch) return uriMatch[1];
  try {
    const url = new URL(trimmed);
    if (/(^|\.)spotify\.com$/.test(url.hostname)) {
      const segments = url.pathname.split("/").filter(Boolean);
      const idx = segments.indexOf(kind);
      const candidate = idx >= 0 ? segments[idx + 1] : undefined;
      if (candidate && /^[A-Za-z0-9]+$/.test(candidate)) return candidate;
    }
  } catch {
    // not a URL
  }
  return /^[A-Za-z0-9]{22}$/.test(trimmed) ? trimmed : null;
}

// Library methods take bare ids; accept a bare id, the matching URI, or an open.spotify.com URL.
function toBareId(input: string, kind: "track" | "album" | "artist"): string {
  const id = extractSpotifyId(input, kind);
  if (id) return id;
  throw new Error(`Invalid Spotify ${kind} id "${input}". Pass a 22-character id, a "spotify:${kind}:" URI, or an open.spotify.com URL.`);
}

// Music-only scope: accept a track id, URI, or open.spotify.com/track URL; normalize to a track URI.
function toTrackUri(input: string): string {
  const id = extractSpotifyId(input, "track");
  if (id) return `spotify:track:${id}`;
  throw new Error(`Invalid Spotify track "${input}". Pass a track id, "spotify:track:<id>" URI, or open.spotify.com/track/<id> URL.`);
}

// A playback "context" is an album, playlist, or artist (id, URI, or URL).
function toContextUri(input: string): string {
  for (const kind of ["album", "playlist", "artist"] as const) {
    const id = extractSpotifyId(input, kind);
    if (id) return `spotify:${kind}:${id}`;
  }
  throw new Error(`Invalid Spotify context "${input}". Expected an album, playlist, or artist id/URI/URL.`);
}

// Resolve a playlist argument (id, URL, URI, or a "~N" pending-create placeholder) to a logical id.
function toPlaylistLogicalId(input: string): string {
  const trimmed = input.trim();
  if (/^~\d+$/.test(trimmed)) return trimmed;
  const id = extractSpotifyId(trimmed, "playlist");
  if (id) return id;
  throw new Error(`Invalid Spotify playlist id "${input}". Pass a playlist id, URL, or URI.`);
}

const SEARCH_TYPES = new Set(["track", "artist", "album", "playlist"]);
const TOP_TIME_RANGES = new Set(["short_term", "medium_term", "long_term"]);
const REPEAT_MODES = new Set(["off", "track", "context"]);
const MAX_PLAYLIST_URIS_PER_CALL = 100;
// Spotify's dev-mode search cap. We always fetch this many and slice down, so that dropped null
// placeholders in playlist results don't shrink a small requested limit below what was asked.
const SEARCH_FETCH_MAX = 10;

// Used by methods that opt out of generated RPC validation (@skipRpcValidation) so they can emit
// friendly domain errors instead of the framework's raw "expected union" message. Such methods
// MUST validate every argument by hand, since the generated checks no longer run.
function assertOptionalDeviceId(deviceId: unknown): void {
  if (deviceId !== undefined && typeof deviceId !== "string") {
    throw new Error("deviceId must be a string when provided.");
  }
}

function assertOptionalLimit(limit: unknown): void {
  if (limit !== undefined && typeof limit !== "number") {
    throw new Error("limit must be a number when provided.");
  }
}

@validateRpc()
export class SpotifyGatekeeperImpl extends DurableObject<Env, SpotifyGatekeeperImplProps>
  implements Gatekeeper<SpotifyAccountSession | SpotifyPlaylist> {

  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #withApi: WithApi = async <T>(fn: (api: SpotifyApi) => Promise<T>): Promise<T> => {
    const account = this.#userAccount();
    const api = new SpotifyApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Spotify credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  };

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "playlist") {
      const playlistId = this.ctx.props.playlistId!;
      const playlist = await this.#withApi(api => api.getPlaylist(playlistId));
      const summary = normalizePlaylistSummary(playlist);
      return {
        url: summary.url,
        title: summary.name,
        snippet: summary.description?.trim() ||
          `Playlist by ${summary.owner.displayName ?? summary.owner.id} · ${summary.trackCount} tracks`,
        suggestedBindingName: "SPOTIFY_PLAYLIST",
        tsType: "SpotifyPlaylist",
      };
    }

    const user = await this.#withApi(api => api.getCurrentUser());
    return {
      url: externalUrl(user, profileUrl(user.id)),
      title: user.display_name ? `${user.display_name}'s Spotify` : "Spotify Account",
      snippet: "Whole-account access: library, playlists, search, and playback control.",
      suggestedBindingName: "SPOTIFY_ACCOUNT",
      tsType: "SpotifyAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getActionCatalog(): Promise<ActionCapability[]> {
    return ACTION_CATALOG;
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<SpotifyAccountSession | SpotifyPlaylist> {
    const owned = recorder.dup();
    if (this.ctx.props.resourceKind === "playlist") {
      return new SpotifyPlaylistImpl(this, owned, this.ctx.props.playlistId!);
    }
    return new SpotifyAccountSessionImpl(this, owned);
  }

  /**
   * Observer tracking: Spotify uses the "low-stakes" strategy. A personal Spotify account (profile,
   * library, playlists, playback) is not the kind of restricted, access-controlled corporate data
   * the information-flow model exists to protect — if you share a Gadget that can read your
   * playlists, that is your call. So any collaborator may observe: addObserver/removeObserver are
   * no-ops and we never set excludeObservers on observations.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Actions

  /**
   * Authorize an action, perform it against Spotify, and record its outcome. A failure after the
   * request was sent leaves the outcome unknown, so it is reported as possibly having taken effect.
   */
  async performAction<T>(
    recorder: RpcStub<ActionRecorder>,
    description: ActionDescription,
    perform: () => Promise<T>,
  ): Promise<T> {
    const handle = await recorder.authorizeAction(description);
    try {
      const result = await perform();
      await handle.succeeded();
      return result;
    } catch (error) {
      await handle.failed(error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Playlist cache
  //
  // Only the (small) playlist summary is cached in KV, keeping KV values small regardless of
  // playlist size. Track pages are read straight through.

  #playlistDetailsKey(realId: string): string { return `pldetails:${realId}`; }
  #invalidatePlaylist(realId: string): void { this.ctx.storage.kv.delete(this.#playlistDetailsKey(realId)); }

  async #getPlaylistSummary(realId: string): Promise<SpotifyPlaylistSummary> {
    const key = this.#playlistDetailsKey(realId);
    const cached = this.ctx.storage.kv.get<PlaylistDetailsCache>(key);
    if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) {
      return cached.summary;
    }
    let summary: SpotifyPlaylistSummary;
    try {
      summary = normalizePlaylistSummary(await this.#withApi(api => api.getPlaylist(realId)));
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 404) {
        throw new Error(`No Spotify playlist found with id "${realId}".`, { cause: error });
      }
      throw error;
    }
    this.ctx.storage.kv.put<PlaylistDetailsCache>(key, { fetchedAt: Date.now(), summary });
    return summary;
  }


  /**
   * Verify the connected user may edit this playlist (owns it, or it's collaborative) before
   * changing it, and return its current track count for bounds checks.
   */
  async assertEditablePlaylist(playlistId: string): Promise<{ trackCount: number }> {
    const [summary, me] = await Promise.all([
      this.#getPlaylistSummary(playlistId), this.#currentUserRef(),
    ]);
    if (summary.owner.id !== me.id && !summary.collaborative) {
      throw new Error(
        `Cannot edit playlist "${summary.name}": it is owned by ` +
        `${summary.owner.displayName ?? summary.owner.id} and is not collaborative.`);
    }
    return { trackCount: summary.trackCount };
  }

  #playlistCountKey(realId: string): string { return `plcount:${realId}`; }




  // -------------------------------------------------------------------------
  // Reads (with simulation overlay)

  #cachedUserRef?: SpotifyUserRef;
  async #currentUserRef(): Promise<SpotifyUserRef> {
    if (!this.#cachedUserRef) {
      this.#cachedUserRef = normalizeUserRef(await this.#withApi(api => api.getCurrentUser()));
    }
    return this.#cachedUserRef;
  }

  async getProfile(): Promise<SpotifyProfile> {
    return normalizeProfile(await this.#withApi(api => api.getCurrentUser()));
  }

  async search(query: string, types: SpotifySearchType[], limit?: number): Promise<SpotifySearchResults> {
    // Feb 2026 reduced the search limit maximum from 50 to 10 for development-mode apps.
    const count = clampLimit(limit, 10, 10);
    // Spotify sprinkles `null` placeholders into playlist search results, which we drop — so a
    // small limit can filter down to fewer (even zero) items. Over-fetch to the API max and then
    // slice each category to the requested count to backfill those gaps.
    const result = await this.#withApi(api => api.search(query, types, SEARCH_FETCH_MAX));
    return {
      tracks: (result.tracks?.items ?? []).filter(Boolean).map(normalizeTrack).slice(0, count),
      artists: (result.artists?.items ?? []).filter(Boolean).map(normalizeArtistRef).slice(0, count),
      albums: (result.albums?.items ?? []).filter(Boolean).map(normalizeAlbumRef).slice(0, count),
      playlists: (result.playlists?.items ?? []).filter(Boolean).map(normalizePlaylistSummary).slice(0, count),
    };
  }

  async getTrack(trackId: string): Promise<SpotifyTrack> {
    try {
      return normalizeTrack(await this.#withApi(api => api.getTrack(trackId)));
    } catch (error) {
      if (error instanceof SpotifyApiError && (error.status === 404 || error.status === 400)) {
        throw new Error(`No Spotify track found with id "${trackId}".`, { cause: error });
      }
      throw error;
    }
  }

  async getTopTracks(timeRange: SpotifyTopTimeRange | undefined, limit?: number): Promise<SpotifyTrack[]> {
    const result = await this.#withApi(api => api.getTopTracks(normalizeTimeRange(timeRange), clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(normalizeTrack);
  }

  async getTopArtists(timeRange: SpotifyTopTimeRange | undefined, limit?: number): Promise<SpotifyArtistRef[]> {
    const result = await this.#withApi(api => api.getTopArtists(normalizeTimeRange(timeRange), clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(normalizeArtistRef);
  }

  async areTracksSaved(trackIds: string[]): Promise<boolean[]> {
    if (trackIds.length === 0) return [];
    const saved = await this.#withApi(api => api.libraryContains(trackIds.map(trackUri)));
    return trackIds.map((_id, i) => saved[i] ?? false);
  }

  async areArtistsFollowed(artistIds: string[]): Promise<boolean[]> {
    if (artistIds.length === 0) return [];
    const following = await this.#withApi(api => api.libraryContains(artistIds.map(artistUri)));
    return artistIds.map((_id, i) => following[i] ?? false);
  }

  async areAlbumsSaved(albumIds: string[]): Promise<boolean[]> {
    if (albumIds.length === 0) return [];
    const saved = await this.#withApi(api => api.libraryContains(albumIds.map(albumUri)));
    return albumIds.map((_id, i) => saved[i] ?? false);
  }

  async isFollowingPlaylist(playlistId: string): Promise<boolean> {
    return (await this.#withApi(api => api.libraryContains([playlistUri(playlistId)])))[0] ?? false;
  }

  async listSavedTracks(limit?: number, offset?: number): Promise<SpotifyTrack[]> {
    const lim = clampLimit(limit, 20, 50);
    const base = await this.#withApi(api => api.listSavedTracks(lim, clampOffset(offset)));
    return (base.items ?? []).map(item => normalizeTrack(item.track));
  }

  async listSavedAlbums(limit?: number, offset?: number): Promise<SpotifyAlbumRef[]> {
    const lim = clampLimit(limit, 20, 50);
    const base = await this.#withApi(api => api.listSavedAlbums(lim, clampOffset(offset)));
    return (base.items ?? []).map(item => normalizeAlbumRef(item.album));
  }

  async listPlaylists(limit?: number, offset?: number): Promise<SpotifyPlaylistSummary[]> {
    const lim = clampLimit(limit, 20, 50);
    const base = await this.#withApi(api => api.listMyPlaylists(lim, clampOffset(offset)));
    const summaries = (base.items ?? []).filter(Boolean).map(normalizePlaylistSummary);
    // Remember each playlist's real track count. GET /playlists/{id} withholds it for playlists the
    // user doesn't own, so getDetails() uses this as a fallback to stay consistent with listPlaylists.
    for (const summary of summaries) {
      this.ctx.storage.kv.put(this.#playlistCountKey(summary.id), summary.trackCount);
    }
    return summaries;
  }

  async playlistGetDetails(playlistId: string): Promise<SpotifyPlaylistSummary> {
    const summary = await this.#getPlaylistSummary(playlistId);
    if (summary.trackCount === 0) {
      // Spotify withholds the count for non-owned playlists here; fall back to a count we saw via
      // listPlaylists so the two reads agree.
      const cached = this.ctx.storage.kv.get<number>(this.#playlistCountKey(playlistId));
      if (cached) return { ...summary, trackCount: cached };
    }
    return summary;
  }

  async playlistListTracks(playlistId: string, limit?: number, offset?: number): Promise<SpotifyPlaylistTrack[]> {
    const lim = clampLimit(limit, 50, 50);
    const off = clampOffset(offset);
    let page;
    try {
      page = await this.#withApi(api => api.listPlaylistItems(playlistId, lim, off));
    } catch (error) {
      // Non-owned playlists: Spotify withholds contents (403). Match the documented empty result.
      if (error instanceof SpotifyApiError && error.status === 403) return [];
      throw error;
    }
    return (page.items ?? []).map((item, index) => {
      const track = item.item ?? item.track ?? null;
      return {
        position: off + index,
        addedAt: item.added_at ? new Date(item.added_at) : null,
        addedBy: item.added_by ? normalizeUserRef(item.added_by) : null,
        track: track ? normalizeTrack(track) : null,
      };
    });
  }

  async playerGetState(): Promise<SpotifyPlaybackState> {
    return normalizePlaybackState(await this.#withApi(api => api.getPlaybackState()));
  }

  async playerGetDevices(): Promise<SpotifyDevice[]> {
    return (await this.#withApi(api => api.getDevices())).map(normalizeDevice);
  }

  async playerGetQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }> {
    const result = await this.#withApi(api => api.getQueue());
    if (!result) return { currentlyPlaying: null, queue: [] };
    return {
      currentlyPlaying: result.currently_playing ? normalizeTrack(result.currently_playing) : null,
      queue: (result.queue ?? []).map(normalizeTrack),
    };
  }

  async playerGetRecentlyPlayed(limit?: number): Promise<SpotifyPlayHistoryEntry[]> {
    const result = await this.#withApi(api => api.getRecentlyPlayed(clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(item => ({
      track: normalizeTrack(item.track),
      playedAt: new Date(item.played_at),
      contextUri: item.context?.uri ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Writes

  saveTracks(trackIds: string[]): Promise<void> {
    return this.#withApi(api => api.saveToLibrary(trackIds.map(trackUri)));
  }
  removeSavedTracks(trackIds: string[]): Promise<void> {
    return this.#withApi(api => api.removeFromLibrary(trackIds.map(trackUri)));
  }
  saveAlbums(albumIds: string[]): Promise<void> {
    return this.#withApi(api => api.saveToLibrary(albumIds.map(albumUri)));
  }
  removeSavedAlbums(albumIds: string[]): Promise<void> {
    return this.#withApi(api => api.removeFromLibrary(albumIds.map(albumUri)));
  }
  followArtists(artistIds: string[]): Promise<void> {
    return this.#withApi(api => api.saveToLibrary(artistIds.map(artistUri)));
  }
  unfollowArtists(artistIds: string[]): Promise<void> {
    return this.#withApi(api => api.removeFromLibrary(artistIds.map(artistUri)));
  }

  async playlistCreate(
    name: string,
    options?: { description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<string> {
    const created = await this.#withApi(api => api.createPlaylist({
      name,
      description: options?.description,
      public: options?.public,
      collaborative: options?.collaborative,
    }));
    return created.id;
  }

  async playlistAddTracks(playlistId: string, uris: string[], position?: number): Promise<void> {
    let at = position;
    for (let i = 0; i < uris.length; i += PLAYLIST_WRITE_CHUNK) {
      const chunk = uris.slice(i, i + PLAYLIST_WRITE_CHUNK);
      await this.#withApi(api => api.addPlaylistItems(playlistId, chunk, at));
      if (at !== undefined) at += chunk.length;
    }
    this.#invalidatePlaylist(playlistId);
  }

  async playlistRemoveTracks(playlistId: string, uris: string[]): Promise<void> {
    await this.#withApi(api => api.removePlaylistItems(playlistId, uris));
    this.#invalidatePlaylist(playlistId);
  }

  async playlistReorderTracks(
    playlistId: string, rangeStart: number, insertBefore: number, rangeLength: number,
  ): Promise<void> {
    await this.#withApi(
      api => api.reorderPlaylistItems(playlistId, rangeStart, insertBefore, rangeLength));
    this.#invalidatePlaylist(playlistId);
  }

  async playlistReplaceTracks(playlistId: string, uris: string[]): Promise<void> {
    await this.#withApi(api => api.replacePlaylistItems(playlistId, uris.slice(0, PLAYLIST_WRITE_CHUNK)));
    for (let i = PLAYLIST_WRITE_CHUNK; i < uris.length; i += PLAYLIST_WRITE_CHUNK) {
      await this.#withApi(api => api.addPlaylistItems(playlistId, uris.slice(i, i + PLAYLIST_WRITE_CHUNK)));
    }
    this.#invalidatePlaylist(playlistId);
  }

  async playlistChangeDetails(playlistId: string, update: SpotifyPlaylistDetailsUpdate): Promise<void> {
    await this.#withApi(api => api.changePlaylistDetails(playlistId, update));
    this.#invalidatePlaylist(playlistId);
  }

  async playlistUnfollow(playlistId: string): Promise<void> {
    await this.#withApi(api => api.removeFromLibrary([playlistUri(playlistId)]));
    this.#invalidatePlaylist(playlistId);
  }

  async playlistFollow(playlistId: string): Promise<void> {
    await this.#withApi(api => api.saveToLibrary([playlistUri(playlistId)]));
    this.#invalidatePlaylist(playlistId);
  }

  async playerCommand(command: PlayerCommand): Promise<void> {
    switch (command.op) {
      case "play": return await this.#withApi(api => api.play(command.deviceId, command.body));
      case "pause": return await this.#withApi(api => api.pause(command.deviceId));
      case "next": return await this.#withApi(api => api.next(command.deviceId));
      case "previous": return await this.#withApi(api => api.previous(command.deviceId));
      case "seek": return await this.#withApi(api => api.seek(command.positionMs, command.deviceId));
      case "setVolume": return await this.#withApi(api => api.setVolume(command.volumePercent, command.deviceId));
      case "setShuffle": return await this.#withApi(api => api.setShuffle(command.shuffle, command.deviceId));
      case "setRepeat": return await this.#withApi(api => api.setRepeat(command.mode, command.deviceId));
      case "transfer": return await this.#withApi(api => api.transfer(command.deviceId, command.play));
      case "addToQueue": return await this.#withApi(api => api.addToQueue(command.uri, command.deviceId));
    }
  }
}

// ---------------------------------------------------------------------------
// Session implementations

function disposeRecorder(recorder: RpcStub<ActionRecorder>): void {
  (recorder as RpcStub<ActionRecorder> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

@validateRpc()
class SpotifyPlayerImpl extends RpcTarget implements SpotifyPlayer {
  #gk: SpotifyGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;

  constructor(gk: SpotifyGatekeeperImpl, recorder: RpcStub<ActionRecorder>) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
  }

  [Symbol.dispose](): void {
    disposeRecorder(this.#recorder);
  }

  async #submit(command: PlayerCommand, title: string, description: string): Promise<void> {
    await this.#gk.performAction(
      this.#recorder, { title, description, actionKind: PLAYBACK_CONTROL },
      () => this.#gk.playerCommand(command));
  }

  async getState(): Promise<SpotifyPlaybackState> {
    const state = await this.#gk.playerGetState();
    await this.#recorder.authorizeObservation({
      title: "Read playback state",
      description: "Read the current Spotify playback state and active device.",
    });
    return state;
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const devices = await this.#gk.playerGetDevices();
    await this.#recorder.authorizeObservation({
      title: "List playback devices",
      description: "List the available Spotify Connect devices.",
    });
    return devices;
  }

  async getQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }> {
    const result = await this.#gk.playerGetQueue();
    await this.#recorder.authorizeObservation({
      title: "Read playback queue",
      description: "Read the currently playing track and the upcoming playback queue.",
    });
    return result;
  }

  async getRecentlyPlayed(limit?: number): Promise<SpotifyPlayHistoryEntry[]> {
    const result = await this.#gk.playerGetRecentlyPlayed(limit);
    await this.#recorder.authorizeObservation({
      title: "Read recently played",
      description: "Read recently played tracks from listening history.",
    });
    return result;
  }

  async play(options?: SpotifyPlayOptions): Promise<void> {
    if (options?.contextUri && options?.trackUris) {
      throw new Error("play(): provide either contextUri or trackUris, not both.");
    }
    const body: Record<string, unknown> = {};
    if (options?.contextUri) body.context_uri = toContextUri(options.contextUri);
    if (options?.trackUris) body.uris = options.trackUris.map(toTrackUri);
    if (options?.offsetPosition !== undefined) body.offset = { position: options.offsetPosition };
    if (options?.positionMs !== undefined) body.position_ms = options.positionMs;
    await this.#submit(
      { op: "play", deviceId: options?.deviceId, body },
      "Start/resume playback",
      "Start or resume Spotify playback on the active device.",
    );
  }

  async pause(deviceId?: string): Promise<void> {
    await this.#submit({ op: "pause", deviceId }, "Pause playback", "Pause Spotify playback.");
  }

  async next(deviceId?: string): Promise<void> {
    await this.#submit({ op: "next", deviceId }, "Skip to next track", "Skip to the next track.");
  }

  async previous(deviceId?: string): Promise<void> {
    await this.#submit({ op: "previous", deviceId }, "Skip to previous track", "Skip to the previous track.");
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new Error("seek(): positionMs must be a non-negative number of milliseconds.");
    }
    const pos = Math.floor(positionMs);
    await this.#submit({ op: "seek", positionMs: pos, deviceId }, "Seek playback", `Seek to ${pos} ms in the current track.`);
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100) {
      throw new Error("setVolume(): volumePercent must be between 0 and 100.");
    }
    const volume = Math.round(volumePercent);
    await this.#submit({ op: "setVolume", volumePercent: volume, deviceId }, "Set volume", `Set playback volume to ${volume}%.`);
  }

  @skipRpcValidation()
  async setShuffle(shuffle: boolean, deviceId?: string): Promise<void> {
    if (typeof shuffle !== "boolean") {
      throw new Error("setShuffle(): shuffle must be a boolean (true or false).");
    }
    assertOptionalDeviceId(deviceId);
    await this.#submit({ op: "setShuffle", shuffle, deviceId }, "Set shuffle", `Turn shuffle ${shuffle ? "on" : "off"}.`);
  }

  @skipRpcValidation()
  async setRepeat(mode: string, deviceId?: string): Promise<void> {
    if (typeof mode !== "string" || !REPEAT_MODES.has(mode)) {
      throw new Error(`setRepeat(): mode must be one of "off", "track", or "context".`);
    }
    assertOptionalDeviceId(deviceId);
    await this.#submit({ op: "setRepeat", mode: mode as SpotifyRepeatMode, deviceId }, "Set repeat mode", `Set repeat mode to "${mode}".`);
  }

  async transferTo(deviceId: string, play?: boolean): Promise<void> {
    if (typeof deviceId !== "string" || deviceId.trim() === "") {
      throw new Error("transferTo(): deviceId must be a non-empty string.");
    }
    await this.#submit(
      { op: "transfer", deviceId, play: play ?? false },
      "Transfer playback",
      `Move playback to device ${deviceId}${play ? " and resume" : ""}.`,
    );
  }

  async addToQueue(uri: string, deviceId?: string): Promise<void> {
    const trackUriValue = toTrackUri(uri);
    await this.#submit({ op: "addToQueue", uri: trackUriValue, deviceId }, "Add to queue", `Add ${trackUriValue} to the playback queue.`);
  }
}

@validateRpc()
class SpotifyPlaylistImpl extends RpcTarget implements SpotifyPlaylist {
  #gk: SpotifyGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;
  #playlistId: string;

  constructor(gk: SpotifyGatekeeperImpl, recorder: RpcStub<ActionRecorder>, playlistId: string) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
    this.#playlistId = playlistId;
  }

  [Symbol.dispose](): void {
    disposeRecorder(this.#recorder);
  }

  async getDetails(): Promise<SpotifyPlaylistSummary> {
    const summary = await this.#gk.playlistGetDetails(this.#playlistId);
    await this.#recorder.authorizeObservation({
      title: `Read playlist "${summary.name}"`,
      description: `Read details of the Spotify playlist "${summary.name}" (${summary.trackCount} tracks).`,
    });
    return summary;
  }

  async listTracks(limit?: number, offset?: number): Promise<SpotifyPlaylistTrack[]> {
    const tracks = await this.#gk.playlistListTracks(this.#playlistId, limit, offset);
    await this.#recorder.authorizeObservation({
      title: "Read playlist tracks",
      description: `Read ${tracks.length} track(s) from the playlist.`,
    });
    return tracks;
  }

  async addTracks(trackUris: string[], position?: number): Promise<void> {
    if (trackUris.length === 0) return;
    if (trackUris.length > MAX_PLAYLIST_URIS_PER_CALL) {
      throw new Error(`addTracks(): at most ${MAX_PLAYLIST_URIS_PER_CALL} URIs per call.`);
    }
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
      throw new Error("addTracks(): position must be a non-negative integer.");
    }
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#playlistId);
    await this.#gk.performAction(this.#recorder, {
      title: `Add ${uris.length} track(s) to playlist`,
      description: `Add ${uris.length} track(s) to the playlist${position === undefined ? "" : ` at position ${position}`}.`,
      actionKind: PLAYLIST_EDIT,
    }, () => this.#gk.playlistAddTracks(this.#playlistId, uris, position));
  }

  async removeTracks(trackUris: string[]): Promise<void> {
    if (trackUris.length === 0) return;
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#playlistId);
    await this.#gk.performAction(this.#recorder, {
      title: `Remove ${uris.length} track(s) from playlist`,
      description: `Remove ${uris.length} track(s) from the playlist.`,
      actionKind: PLAYLIST_EDIT,
    }, () => this.#gk.playlistRemoveTracks(this.#playlistId, uris));
  }

  async reorderTracks(rangeStart: number, insertBefore: number, rangeLength?: number): Promise<void> {
    const length = rangeLength ?? 1;
    if (!Number.isInteger(rangeStart) || rangeStart < 0 ||
        !Number.isInteger(insertBefore) || insertBefore < 0 ||
        !Number.isInteger(length) || length < 1) {
      throw new Error("reorderTracks(): rangeStart/insertBefore must be >= 0 and rangeLength >= 1.");
    }
    const { trackCount } = await this.#gk.assertEditablePlaylist(this.#playlistId);
    if (rangeStart + length > trackCount || insertBefore > trackCount) {
      throw new Error(`reorderTracks(): range is out of bounds for a playlist with ${trackCount} track(s).`);
    }
    await this.#gk.performAction(this.#recorder, {
      title: "Reorder playlist tracks",
      description: `Move ${length} track(s) from position ${rangeStart} to before position ${insertBefore}.`,
      actionKind: PLAYLIST_EDIT,
    }, () => this.#gk.playlistReorderTracks(this.#playlistId, rangeStart, insertBefore, length));
  }

  async replaceTracks(trackUris: string[]): Promise<void> {
    if (trackUris.length > MAX_PLAYLIST_URIS_PER_CALL) {
      throw new Error(`replaceTracks(): at most ${MAX_PLAYLIST_URIS_PER_CALL} URIs per call.`);
    }
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#playlistId);
    await this.#gk.performAction(this.#recorder, {
      title: "Replace playlist tracks",
      description: `Replace the playlist's contents with ${uris.length} track(s).`,
      actionKind: PLAYLIST_EDIT,
    }, () => this.#gk.playlistReplaceTracks(this.#playlistId, uris));
  }

  async changeDetails(update: SpotifyPlaylistDetailsUpdate): Promise<void> {
    if (Object.keys(update).length === 0) return;
    if (update.public === true && update.collaborative === true) {
      throw new Error("changeDetails(): a collaborative playlist must be private (public and collaborative cannot both be true).");
    }
    await this.#gk.assertEditablePlaylist(this.#playlistId);
    const fields = Object.keys(update).join(", ") || "details";
    await this.#gk.performAction(this.#recorder, {
      title: "Change playlist details",
      description: `Update playlist ${fields}.`,
      actionKind: PLAYLIST_EDIT,
    }, () => this.#gk.playlistChangeDetails(this.#playlistId, update));
  }

  async unfollow(): Promise<void> {
    await this.#gk.performAction(this.#recorder, {
      title: "Remove playlist from library",
      description: "Remove this playlist from your library (for a playlist you own, this deletes it).",
      actionKind: PLAYLIST_LIBRARY,
    }, () => this.#gk.playlistUnfollow(this.#playlistId));
  }

  async follow(): Promise<void> {
    await this.#gk.performAction(this.#recorder, {
      title: "Add playlist to library",
      description: "Follow this playlist (add it to your library).",
      actionKind: PLAYLIST_LIBRARY,
    }, () => this.#gk.playlistFollow(this.#playlistId));
  }

  async isFollowing(): Promise<boolean> {
    const result = await this.#gk.isFollowingPlaylist(this.#playlistId);
    await this.#recorder.authorizeObservation({
      title: "Check playlist follow status",
      description: "Check whether this playlist is in your library.",
    });
    return result;
  }
}

@validateRpc()
class SpotifyAccountSessionImpl extends RpcTarget implements SpotifyAccountSession {
  #gk: SpotifyGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;

  constructor(gk: SpotifyGatekeeperImpl, recorder: RpcStub<ActionRecorder>) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
  }

  [Symbol.dispose](): void {
    disposeRecorder(this.#recorder);
  }

  async getProfile(): Promise<SpotifyProfile> {
    const profile = await this.#gk.getProfile();
    await this.#recorder.authorizeObservation({
      title: "Read Spotify profile",
      description: `Read the connected Spotify account's profile (${profile.displayName ?? profile.id}).`,
    });
    return profile;
  }

  @skipRpcValidation()
  async search(query: string, types: string[], limit?: number): Promise<SpotifySearchResults> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("search(): query must be a non-empty string.");
    }
    if (!Array.isArray(types) || types.length === 0) {
      throw new Error("search(): provide at least one type (track, artist, album, or playlist).");
    }
    for (const type of types) {
      if (typeof type !== "string" || !SEARCH_TYPES.has(type)) {
        throw new Error(`search(): unknown type "${type}". Valid types: track, artist, album, playlist.`);
      }
    }
    assertOptionalLimit(limit);
    const results = await this.#gk.search(query, types as SpotifySearchType[], limit);
    await this.#recorder.authorizeObservation({
      title: `Search Spotify for "${query}"`,
      description: `Search the Spotify catalog for "${query}" (${types.join(", ")}).`,
    });
    return results;
  }

  async getTrack(trackId: string): Promise<SpotifyTrack> {
    const track = await this.#gk.getTrack(toBareId(trackId, "track"));
    await this.#recorder.authorizeObservation({
      title: `Read track "${track.name}"`,
      description: `Read catalog details for the track "${track.name}".`,
    });
    return track;
  }

  async listSavedTracks(limit?: number, offset?: number): Promise<SpotifyTrack[]> {
    const tracks = await this.#gk.listSavedTracks(limit, offset);
    await this.#recorder.authorizeObservation({
      title: "Read saved tracks",
      description: `Read ${tracks.length} saved track(s) from the library.`,
    });
    return tracks;
  }

  async listSavedAlbums(limit?: number, offset?: number): Promise<SpotifyAlbumRef[]> {
    const albums = await this.#gk.listSavedAlbums(limit, offset);
    await this.#recorder.authorizeObservation({
      title: "Read saved albums",
      description: `Read ${albums.length} saved album(s) from the library.`,
    });
    return albums;
  }

  async areTracksSaved(trackIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areTracksSaved(trackIds.map(id => toBareId(id, "track")));
    await this.#recorder.authorizeObservation({
      title: "Check saved tracks",
      description: `Check whether ${trackIds.length} track(s) are saved in the library.`,
    });
    return result;
  }

  async areAlbumsSaved(albumIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areAlbumsSaved(albumIds.map(id => toBareId(id, "album")));
    await this.#recorder.authorizeObservation({
      title: "Check saved albums",
      description: `Check whether ${albumIds.length} album(s) are saved in the library.`,
    });
    return result;
  }

  @skipRpcValidation()
  async getTopTracks(timeRange?: string, limit?: number): Promise<SpotifyTrack[]> {
    if (timeRange !== undefined && (typeof timeRange !== "string" || !TOP_TIME_RANGES.has(timeRange))) {
      throw new Error(`getTopTracks(): invalid timeRange "${timeRange}". Use short_term, medium_term, or long_term.`);
    }
    assertOptionalLimit(limit);
    const tracks = await this.#gk.getTopTracks(timeRange as SpotifyTopTimeRange | undefined, limit);
    await this.#recorder.authorizeObservation({
      title: "Read top tracks",
      description: `Read the user's top ${tracks.length} track(s).`,
    });
    return tracks;
  }

  @skipRpcValidation()
  async getTopArtists(timeRange?: string, limit?: number): Promise<SpotifyArtistRef[]> {
    if (timeRange !== undefined && (typeof timeRange !== "string" || !TOP_TIME_RANGES.has(timeRange))) {
      throw new Error(`getTopArtists(): invalid timeRange "${timeRange}". Use short_term, medium_term, or long_term.`);
    }
    assertOptionalLimit(limit);
    const artists = await this.#gk.getTopArtists(timeRange as SpotifyTopTimeRange | undefined, limit);
    await this.#recorder.authorizeObservation({
      title: "Read top artists",
      description: `Read the user's top ${artists.length} artist(s).`,
    });
    return artists;
  }

  async saveTracks(trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    const ids = trackIds.map(id => toBareId(id, "track"));
    await this.#gk.performAction(this.#recorder, {
      title: `Save ${ids.length} track(s)`,
      description: `Save ${ids.length} track(s) to the library.`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.saveTracks(ids));
  }

  async removeSavedTracks(trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    const ids = trackIds.map(id => toBareId(id, "track"));
    await this.#gk.performAction(this.#recorder, {
      title: `Remove ${ids.length} saved track(s)`,
      description: `Remove ${ids.length} track(s) from the library.`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.removeSavedTracks(ids));
  }

  async saveAlbums(albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) return;
    const ids = albumIds.map(id => toBareId(id, "album"));
    await this.#gk.performAction(this.#recorder, {
      title: `Save ${ids.length} album(s)`,
      description: `Save ${ids.length} album(s) to the library.`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.saveAlbums(ids));
  }

  async removeSavedAlbums(albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) return;
    const ids = albumIds.map(id => toBareId(id, "album"));
    await this.#gk.performAction(this.#recorder, {
      title: `Remove ${ids.length} saved album(s)`,
      description: `Remove ${ids.length} album(s) from the library.`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.removeSavedAlbums(ids));
  }

  async followArtists(artistIds: string[]): Promise<void> {
    if (artistIds.length === 0) return;
    const ids = artistIds.map(id => toBareId(id, "artist"));
    await this.#gk.performAction(this.#recorder, {
      title: `Follow ${ids.length} artist(s)`,
      description: `Follow ${ids.length} artist(s).`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.followArtists(ids));
  }

  async unfollowArtists(artistIds: string[]): Promise<void> {
    if (artistIds.length === 0) return;
    const ids = artistIds.map(id => toBareId(id, "artist"));
    await this.#gk.performAction(this.#recorder, {
      title: `Unfollow ${ids.length} artist(s)`,
      description: `Unfollow ${ids.length} artist(s).`,
      actionKind: LIBRARY_EDIT,
    }, () => this.#gk.unfollowArtists(ids));
  }

  async isFollowingArtists(artistIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areArtistsFollowed(artistIds.map(id => toBareId(id, "artist")));
    await this.#recorder.authorizeObservation({
      title: "Check followed artists",
      description: `Check whether ${artistIds.length} artist(s) are followed.`,
    });
    return result;
  }

  async listPlaylists(limit?: number, offset?: number): Promise<SpotifyPlaylistSummary[]> {
    const playlists = await this.#gk.listPlaylists(limit, offset);
    await this.#recorder.authorizeObservation({
      title: "List playlists",
      description: `List ${playlists.length} of the user's playlists.`,
    });
    return playlists;
  }

  getPlaylist(playlistId: string): SpotifyPlaylist {
    // Accept a bare id, an open.spotify.com URL, a spotify:playlist: URI, or a "~N" pending id;
    // reject anything malformed up front (rather than leaking a Spotify "Invalid base62 id").
    const logicalId = toPlaylistLogicalId(playlistId);
    return new SpotifyPlaylistImpl(this.#gk, this.#recorder.dup(), logicalId);
  }

  async createPlaylist(
    name: string,
    options?: { description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<SpotifyPlaylist> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("createPlaylist(): name must be a non-empty string.");
    }
    if (options?.public === true && options?.collaborative === true) {
      throw new Error("createPlaylist(): a collaborative playlist must be private (public and collaborative cannot both be true).");
    }
    const createdId = await this.#gk.performAction(this.#recorder, {
      title: `Create playlist "${name}"`,
      description: `Create a new ${options?.public ? "public" : "private"} playlist named "${name}".`,
      actionKind: PLAYLIST_CREATE,
    }, () => this.#gk.playlistCreate(name, options));
    return new SpotifyPlaylistImpl(this.#gk, this.#recorder.dup(), createdId);
  }

  getPlayer(): SpotifyPlayer {
    return new SpotifyPlayerImpl(this.#gk, this.#recorder.dup());
  }
}

// ---------------------------------------------------------------------------
// Resource configurators — narrow, read-only helpers exposed to the sandboxed iframe.
// Credentials are kept private in a WeakMap keyed by the RpcTarget instance.

const configuratorTokenGetters = new WeakMap<object, () => Promise<string>>();

function configuratorApi(target: object): SpotifyApi {
  const getToken = configuratorTokenGetters.get(target);
  if (!getToken) throw new Error("Spotify configurator is not initialized.");
  return new SpotifyApi(getToken);
}

const CONFIGURATOR_OPTION_LIMIT = 50;

@validateRpc()
class SpotifyAccountConfiguratorUI extends RpcTarget implements SpotifyAccountConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async resourceUrl(): Promise<string> {
    const user = await configuratorApi(this).getCurrentUser();
    return externalUrl(user, profileUrl(user.id));
  }
}

@validateRpc()
class SpotifyPlaylistConfiguratorUI extends RpcTarget implements SpotifyPlaylistConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async listPlaylists(query: string): Promise<SpotifyConfiguratorOption[]> {
    const api = configuratorApi(this);
    const trimmed = query.trim();

    // A pasted URL / URI / ID: resolve it directly.
    const directId = parsePlaylistId(trimmed);
    if (directId) {
      try {
        const playlist = await api.getPlaylist(directId);
        return [playlistToOption(playlist)];
      } catch {
        // fall through to search/listing
      }
    }

    // No query: the user's own playlists.
    if (!trimmed) {
      const result = await api.listMyPlaylists(CONFIGURATOR_OPTION_LIMIT, 0);
      return (result.items ?? []).filter(Boolean).map(playlistToOption);
    }

    // Otherwise search the public catalog.
    const result = await api.search(trimmed, ["playlist"], CONFIGURATOR_OPTION_LIMIT);
    return (result.playlists?.items ?? []).filter(Boolean).map(playlistToOption);
  }
}

function playlistToOption(playlist: SpotifyPlaylistResponse): SpotifyConfiguratorOption {
  const ownerName = playlist.owner?.display_name ?? playlist.owner?.id;
  return {
    value: playlist.id,
    title: playlist.name,
    subtitle: ownerName ? `By ${ownerName}` : undefined,
    meta: (playlist.items?.total ?? playlist.tracks?.total) !== undefined
      ? `${playlist.items?.total ?? playlist.tracks?.total} tracks`
      : undefined,
  };
}
