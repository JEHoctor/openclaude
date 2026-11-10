// Forward Claude Code's own OAuth/API authorization to Anthropic. openclaude
// never reads Claude Code's credential store, substitutes tokens, or persists
// upstream credentials.
const PASSTHROUGH_REQUEST_HEADERS = new Set([
  "authorization", "x-api-key", "anthropic-version", "anthropic-beta",
  "anthropic-dangerous-direct-browser-access", "user-agent", "accept",
  "accept-encoding", "content-type",
]);

export async function dispatch({ provider, modelId, body, headers, path, signal }) {
  const url = new URL(path, provider.baseUrl).toString();
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (PASSTHROUGH_REQUEST_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
  }
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/json");
  outHeaders.delete("host");
  return fetch(url, {
    method: "POST", headers: outHeaders,
    body: JSON.stringify({ ...body, model: modelId }), signal,
  });
}
