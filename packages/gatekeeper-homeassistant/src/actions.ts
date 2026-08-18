// Helpers for the action lifecycle of the Home Assistant gatekeeper.
//
// Responsibilities split out from `homeassistant.ts` to keep that file manageable:
// - `describeAction()` — produces a human-readable ActionDescription from a raw action,
//   given a registry snapshot for name lookups.
// - `resolveTargets()` — expands an HA service-call target into the concrete set of
//   affected entity_ids using the registry snapshot.
// - `executeAction()` — actually performs the action against HA.

import type {
  ActionCapability,
  ActionDescription,
  ActionKind,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  withWebSocket,
  type HomeAssistantCredentials,
  type RegistrySnapshot,
} from "./homeassistant-api";
import { resolveTargets } from "./registry-utils";
import type { HATarget, HomeAssistantAction } from "./homeassistant";

export { resolveTargets };

// ---------------------------------------------------------------------------
// Helpers

function asArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function entityFriendlyName(entityId: string, registry: RegistrySnapshot): string {
  const reg = registry.entities.find((e: any) => e.entity_id === entityId);
  const state = registry.states.get(entityId);
  return (
    reg?.name ??
    reg?.original_name ??
    state?.attributes?.friendly_name ??
    entityId
  );
}

function areaName(areaId: string, registry: RegistrySnapshot): string {
  const area = registry.areas.find((a: any) => a.area_id === areaId);
  return area?.name ?? areaId;
}

function labelName(labelId: string, registry: RegistrySnapshot): string {
  const label = registry.labels.find((l: any) => l.label_id === labelId);
  return label?.name ?? labelId;
}

function deviceName(deviceId: string, registry: RegistrySnapshot): string {
  const device = registry.devices.find((d: any) => d.id === deviceId);
  return device?.name_by_user ?? device?.name ?? deviceId;
}

function fmtData(data?: Record<string, unknown>): string {
  if (!data) return "";
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${formatValue(v)}`).join(", ");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Action kinds
//
// Home Assistant drives physical devices, so every action here reaches the world. The three kinds
// separate what a policy would want to govern differently: a service call moves a device, an event
// triggers whatever automations listen for it, and a dashboard save rewrites shared UI.

const SERVICE_CALL: ActionKind = {
  tag: "homeassistant.service.call",
  label: "Control devices",
};
const FIRE_EVENT: ActionKind = {
  tag: "homeassistant.event.fire",
  label: "Fire an event on the event bus",
};
const SAVE_DASHBOARD: ActionKind = {
  tag: "homeassistant.dashboard.save",
  label: "Rewrite a dashboard's configuration",
};

/** Every side-effecting operation this gatekeeper performs, for consent and deployment policy. */
export const ACTION_CATALOG: ActionCapability[] = [
  {
    kind: SERVICE_CALL,
    summary: "Call a Home Assistant service, operating lights, locks, climate, and other devices",
    risk: {
      // Restoring the prior device state is a service call someone has to decide to make.
      reversible: "manual",
      reach: "acts-on-world",
      // Anyone in the home sees a light turn on or a lock open.
      audience: "shared",
      // Service data is arbitrary JSON, and reaches services like notify and tts.
      freeform: true,
    },
  },
  {
    kind: FIRE_EVENT,
    summary: "Fire an arbitrary event on the event bus, triggering any automation listening for it",
    risk: {
      // An event that has already fired cannot be recalled, and its automations have already run.
      reversible: "no",
      reach: "acts-on-world",
      audience: "shared",
      freeform: true,
    },
  },
  {
    kind: SAVE_DASHBOARD,
    summary: "Replace a Lovelace dashboard's configuration",
    risk: {
      reversible: "manual",
      reach: "modifies-content",
      audience: "shared",
      freeform: true,
    },
  },
];

// ---------------------------------------------------------------------------
// Description authoring

export function describeAction(
  action: HomeAssistantAction,
  registry: RegistrySnapshot,
): ActionDescription {
  switch (action.type) {
    case "callService":
      return describeCallService(action, registry);
    case "fireEvent":
      return describeFireEvent(action);
    case "saveDashboard":
      return describeSaveDashboard(action);
  }
}

function describeCallService(
  action: HomeAssistantAction & { type: "callService" },
  registry: RegistrySnapshot,
): ActionDescription {
  const { domain, service, data, target, origin } = action;

  // Safety net: if validation upstream missed something, never let `[object Object]` or
  // `undefined` leak into the approval card title.
  if (typeof domain !== "string" || !domain || typeof service !== "string" || !service) {
    return {
      title: "Invalid service call",
      description:
        `The gatekeeper received a malformed callService action ` +
        `(domain=${JSON.stringify(domain)}, service=${JSON.stringify(service)}). ` +
        `This indicates a programming error in the gadget that called callService(); ` +
        `it likely passed a single options object instead of positional arguments.`,
      actionKind: SERVICE_CALL,
    };
  }

  const dataStr = fmtData(data);

  // Compute the total number of distinct entities affected by this call. Used to enrich
  // titles for area / label / device scopes (where one ID can fan out to many entities), and
  // to display per-area / per-label counts when the target uses only that one dimension.
  const affectedEntities = target ? resolveTargets(target, registry) : new Set<string>();
  const affectedEntityCount = affectedEntities.size;

  // True iff `target` mentions ONLY the given dimension (and nothing else). When this holds,
  // `affectedEntityCount` is exactly the count for that dimension and we can reuse it without
  // a second resolveTargets call.
  const targetDimensions = target
    ? (["entity_id", "device_id", "area_id", "label_id", "floor_id"] as const).filter(
        (k) => target[k] != null,
      )
    : [];
  const targetIsExclusively = (dim: keyof HATarget) =>
    targetDimensions.length === 1 && targetDimensions[0] === dim;

  // Build "what is targeted" text.
  let targetText = "";
  if (target) {
    const parts: string[] = [];
    if (target.entity_id) {
      const ids = asArray(target.entity_id);
      if (ids.length === 1) {
        parts.push(`${entityFriendlyName(ids[0], registry)} (\`${ids[0]}\`)`);
      } else {
        parts.push(`${ids.length} entities`);
      }
    }
    if (target.device_id) {
      const ids = asArray(target.device_id);
      parts.push(
        ids.length === 1
          ? `device "${deviceName(ids[0], registry)}"`
          : `${ids.length} devices`,
      );
    }
    if (target.area_id) {
      const ids = asArray(target.area_id);
      // If the target uses only area_id, the full affected-entity set IS the per-area count.
      // Otherwise we'd need a separate resolveTargets call to isolate the area dimension —
      // skip that for simplicity and just print the area name without a count in mixed cases.
      const includeCount = ids.length === 1 && targetIsExclusively("area_id");
      parts.push(
        ids.length === 1
          ? includeCount
            ? `area "${areaName(ids[0], registry)}" (${affectedEntityCount} entities)`
            : `area "${areaName(ids[0], registry)}"`
          : `${ids.length} areas`,
      );
    }
    if (target.label_id) {
      const ids = asArray(target.label_id);
      const includeCount = ids.length === 1 && targetIsExclusively("label_id");
      parts.push(
        ids.length === 1
          ? includeCount
            ? `label "${labelName(ids[0], registry)}" (${affectedEntityCount} entities)`
            : `label "${labelName(ids[0], registry)}"`
          : `${ids.length} labels`,
      );
    }
    if (target.floor_id) {
      parts.push(`floor ${asArray(target.floor_id).join(", ")}`);
    }
    targetText = parts.join(", ");
  }

  // For multi-entity scopes (area / label / device), append an entity count to the title so
  // the approver immediately sees the blast radius.
  const fanOutSuffix =
    (origin.kind === "area" || origin.kind === "label" || origin.kind === "device") &&
    affectedEntityCount > 1
      ? ` (${affectedEntityCount} entities)`
      : "";

  // Title — prefer a concise human-friendly form when we can.
  let title: string;
  if (origin.kind === "entity") {
    const name = entityFriendlyName(origin.entityId, registry);
    title = `${humanizeService(domain, service)}: ${name}`;
  } else if (origin.kind === "area") {
    title = `${humanizeService(domain, service)} in area "${areaName(origin.areaId, registry)}"${fanOutSuffix}`;
  } else if (origin.kind === "label") {
    title = `${humanizeService(domain, service)} for label "${labelName(origin.labelId, registry)}"${fanOutSuffix}`;
  } else if (origin.kind === "device") {
    title = `${humanizeService(domain, service)} on device "${deviceName(origin.deviceId, registry)}"${fanOutSuffix}`;
  } else {
    title = `Call ${domain}.${service}`;
    if (targetText) title += ` on ${targetText}`;
  }

  // Description — fuller detail for the approver.
  let description = `Calls \`${domain}.${service}\``;
  if (targetText) description += ` on ${targetText}`;
  if (dataStr) description += ` with ${dataStr}`;
  description += ".";

  return {
    title,
    description,
    actionKind: SERVICE_CALL,
  };
}

function describeFireEvent(action: HomeAssistantAction & { type: "fireEvent" }): ActionDescription {
  const dataStr = fmtData(action.data);
  return {
    title: `Fire event: ${action.eventType}`,
    description:
      `Fires the \`${action.eventType}\` event on the Home Assistant event bus` +
      (dataStr ? ` with ${dataStr}` : "") +
      ".",
    actionKind: FIRE_EVENT,
  };
}

function describeSaveDashboard(
  action: HomeAssistantAction & { type: "saveDashboard" },
): ActionDescription {
  const config = action.config as { title?: string; views?: unknown[] } | undefined;
  const urlLabel = action.urlPath ?? "lovelace (default)";
  const viewCount = Array.isArray(config?.views) ? config!.views!.length : 0;
  const cardCount = countCards(config);
  const title = config?.title ? `${config.title}` : urlLabel;
  return {
    title: `Edit dashboard: ${title}`,
    description:
      `Replaces the configuration of the Lovelace dashboard \`${urlLabel}\` ` +
      `with ${viewCount} view${viewCount === 1 ? "" : "s"} and ${cardCount} card${cardCount === 1 ? "" : "s"}.`,
    actionKind: SAVE_DASHBOARD,
  };
}

function countCards(config: any): number {
  if (!config || !Array.isArray(config.views)) return 0;
  let count = 0;
  for (const view of config.views) {
    if (Array.isArray(view?.cards)) count += view.cards.length;
    if (Array.isArray(view?.sections)) {
      for (const section of view.sections) {
        if (Array.isArray(section?.cards)) count += section.cards.length;
      }
    }
  }
  return count;
}

// Maps "<domain>.<service>" to a friendlier verb phrase for titles.
function humanizeService(domain: string, service: string): string {
  const key = `${domain}.${service}`;
  switch (key) {
    case "light.turn_on":
    case "switch.turn_on":
    case "fan.turn_on":
    case "input_boolean.turn_on":
    case "automation.turn_on":
    case "humidifier.turn_on":
      return `Turn on ${domain}`;
    case "light.turn_off":
    case "switch.turn_off":
    case "fan.turn_off":
    case "input_boolean.turn_off":
    case "automation.turn_off":
    case "humidifier.turn_off":
      return `Turn off ${domain}`;
    case "light.toggle":
    case "switch.toggle":
    case "fan.toggle":
    case "input_boolean.toggle":
    case "automation.toggle":
      return `Toggle ${domain}`;
    case "cover.open_cover":
      return "Open cover";
    case "cover.close_cover":
      return "Close cover";
    case "cover.stop_cover":
      return "Stop cover";
    case "cover.set_cover_position":
      return "Set cover position";
    case "climate.set_temperature":
      return "Set temperature";
    case "climate.set_hvac_mode":
      return "Set HVAC mode";
    case "climate.set_fan_mode":
      return "Set fan mode";
    case "lock.lock":
      return "Lock";
    case "lock.unlock":
      return "Unlock";
    case "media_player.media_play":
      return "Play media";
    case "media_player.media_pause":
      return "Pause media";
    case "media_player.media_stop":
      return "Stop media";
    case "media_player.media_next_track":
      return "Next track";
    case "media_player.media_previous_track":
      return "Previous track";
    case "media_player.volume_set":
      return "Set volume";
    case "media_player.volume_mute":
      return "Mute";
    case "media_player.play_media":
      return "Play media";
    case "fan.set_percentage":
      return "Set fan speed";
    case "vacuum.start":
      return "Start vacuum";
    case "vacuum.stop":
      return "Stop vacuum";
    case "vacuum.return_to_base":
      return "Return vacuum to base";
    case "vacuum.locate":
      return "Locate vacuum";
    case "scene.turn_on":
      return "Activate scene";
    case "script.turn_on":
      return "Run script";
    case "button.press":
    case "input_button.press":
      return "Press button";
    case "input_number.set_value":
    case "number.set_value":
      return "Set number value";
    case "input_text.set_value":
    case "text.set_value":
      return "Set text value";
    case "input_select.select_option":
    case "select.select_option":
      return "Select option";
    case "input_datetime.set_datetime":
      return "Set date/time";
    case "automation.trigger":
      return "Trigger automation";
    case "automation.reload":
      return "Reload automations";
    case "notify.send_message":
      return "Send notification";
    default:
      return `Call ${key}`;
  }
}

// ---------------------------------------------------------------------------
// Action execution
//
// All side-effecting actions go through the Home Assistant WebSocket API. The WS API is HA's
// modern path; it supports the full target shape (entity_id, device_id, area_id, label_id,
// floor_id) cleanly, unlike the REST equivalent which has historical quirks (the REST POST
// /api/services/<domain>/<service> endpoint expects target fields flattened at the top level
// of the body, not nested under a `target` key, and has uneven support for area/label/floor
// targets across HA versions).

export async function executeAction(
  action: HomeAssistantAction,
  creds: HomeAssistantCredentials,
): Promise<void> {
  await withWebSocket(creds, async (ws) => {
    switch (action.type) {
      case "callService": {
        await ws.callService(action.domain, action.service, action.data, action.target);
        return;
      }
      case "fireEvent": {
        await ws.fireEvent(action.eventType, action.data);
        return;
      }
      case "saveDashboard": {
        await ws.send({
          type: "lovelace/config/save",
          url_path: action.urlPath,
          config: action.config,
        });
        return;
      }
    }
  });
}
