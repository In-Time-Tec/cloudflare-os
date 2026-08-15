// Teams message bodies are provider HTML. Before any of it reaches the Workshop UI it passes
// through this allowlist sanitizer, built on the Workers-native HTMLRewriter so there is no
// parser dependency and no regex-over-HTML fragility.

const REMOVE_ENTIRELY = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base", "form",
  "input", "button", "textarea", "select", "video", "audio", "source",
]);

const ALLOWED_ATTRIBUTES = new Set(["href", "src", "alt", "title", "itemtype", "itemid"]);

function safeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("https://") || trimmed.startsWith("http://")
      || trimmed.startsWith("mailto:");
}

/**
 * Sanitize one Teams HTML fragment: dangerous elements are dropped with their content, event
 * handlers and unknown attributes are stripped, and URLs must be http(s)/mailto. Text content is
 * preserved. Plain-text messages pass through HTML-escaped by the caller.
 */
export async function sanitizeTeamsHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
      .on("*", {
        element(element) {
          if (REMOVE_ENTIRELY.has(element.tagName)) {
            element.remove();
            return;
          }
          // Materialize first: removing while iterating the live collection skips entries.
          const attributes = Array.from(element.attributes);
          for (const [name, value] of attributes) {
            if (!ALLOWED_ATTRIBUTES.has(name)) {
              element.removeAttribute(name);
              continue;
            }
            if ((name === "href" || name === "src") && !safeUrl(value)) {
              element.removeAttribute(name);
            }
          }
          if (element.tagName === "a") {
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer");
          }
        },
      });
  const response = rewriter.transform(new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  return await response.text();
}

/** Escape plain text for embedding in the message HTML stream. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
