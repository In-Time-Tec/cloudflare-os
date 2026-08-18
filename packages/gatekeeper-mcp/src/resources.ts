import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const DESCRIPTION =
  "An MCP endpoint you supply. Tools are discovered automatically; anything that is not read-only " +
  "is recorded as an action.";

const HTTPS_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Any MCP server",
  description: DESCRIPTION,
};

const HTTP_RESOURCE: SupportedResource = { ...HTTPS_RESOURCE, urlPattern: "http://*" };

export function mcpResources(allowInsecure: boolean): SupportedResource[] {
  return allowInsecure ? [HTTPS_RESOURCE, HTTP_RESOURCE] : [HTTPS_RESOURCE];
}

export function mcpResourceFor(endpoint: string): SupportedResource {
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
