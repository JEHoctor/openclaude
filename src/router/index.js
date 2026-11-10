import { createServer } from "node:http";
import { loadConfig, parseModelTarget } from "./config.js";
import { isAuthorizedLocalRequest } from "./auth.js";
import { sanitizeToolIds, sanitizeThinkingBlocks } from "./sanitize.js";
import * as anthropicPassthrough from "./provider/anthropic-passthrough.js";
import * as ollama from "./provider/ollama.js";

const PROVIDER_IMPL = {
  "anthropic-passthrough": anthropicPassthrough,
  ollama,
};

function log(...args) {
  if (process.env.OPENCLAUDE_QUIET) return;
  console.error("[openclaude]", ...args);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error("Invalid JSON body"), { httpStatus: 400, cause: err });
  }
}

function sendJson(res, status, payload) {
  // Once any byte has been written the status line + headers are already on the
  // wire, so setHeader()/statusCode would throw ERR_HTTP_HEADERS_SENT. That
  // throw, raised from inside an error handler, was crashing the whole daemon.
  // If we can no longer send a clean JSON error, abort the response instead so
  // the client sees a broken stream and retries.
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function handleMessages(req, res, cfg, upstreamPath = "/v1/messages") {
  const body = await readJsonBody(req);
  if (typeof body.model !== "string" || body.model.length === 0) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "missing model" } });
  }

  // Clean up any tool_use ids in the conversation history that were generated
  // by upstreams with looser id rules (e.g. Ollama's compat layer may emit
  // ids containing dots/colons that Anthropic rejects).
  const sanitized = sanitizeToolIds(body);
  if (sanitized.fixed > 0) {
    log(`sanitized ${sanitized.fixed} dirty tool_use id(s) in conversation history`);
  }
  Object.assign(body, sanitized.body);

  // Drop thinking blocks whose signature looks fake (non-Anthropic origin).
  // Anthropic validates signatures on replay; non-Anthropic upstreams emit
  // empty/short signatures that get rejected.
  const dethought = sanitizeThinkingBlocks(body);
  if (dethought.fixed > 0) {
    log(`dropped ${dethought.fixed} thinking block(s) with non-Anthropic signature`);
  }
  Object.assign(body, dethought.body);

  const { providerId, modelId } = parseModelTarget(body.model, cfg);
  const provider = cfg.providers?.[providerId];
  if (provider?.type === "ollama" && providerId === "ollama-local" && !(cfg.ollamaAllowedModels ?? []).includes(modelId)) {
    return sendJson(res, 403, { type: "error", error: { type: "permission_error", message: `Ollama model "${modelId}" is not in ollamaAllowedModels` } });
  }
  if (!provider) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: `Unknown provider "${providerId}" — check ${cfg.configPath ?? "config.json"}` } });
  }
  const impl = PROVIDER_IMPL[provider.type];
  if (!impl) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: `Provider type "${provider.type}" not supported` } });
  }

  log("→", `${providerId}:${modelId}`);
  body.model = modelId;

  // When the client disconnects mid-stream (Ctrl+C in Claude Code, network drop),
  // abort the upstream fetch instead of draining bytes to a dead socket. Without
  // this, an Ollama Cloud stream that takes 60s to finish keeps consuming quota
  // after the user has already cancelled.
  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  req.once("close", onClientClose);

  let reader = null;
  try {
    const upstream = await impl.dispatch({
      provider,
      modelId,
      body,
      headers: req.headers,
      path: upstreamPath,
      signal: controller.signal,
    });

    log(`← ${providerId}:${modelId} status ${upstream.status}`);
    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers.entries()) {
      if (k.toLowerCase() === "content-encoding") continue;
      if (k.toLowerCase() === "content-length") continue;
      res.setHeader(k, v);
    }

    // For non-2xx non-streaming responses, peek the body once and log a snippet
    // before forwarding it on. Diagnoses the common cause of retry loops
    // (401 unauthorized, 404 model not found, 400 invalid body) without
    // needing tcpdump.
    const ct = upstream.headers.get("content-type") ?? "";
    if (upstream.body && !upstream.ok && !ct.includes("text/event-stream")) {
      const buf = await upstream.arrayBuffer();
      const text = Buffer.from(buf).toString("utf8");
      log(`!! upstream error body: ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`);
      res.end(Buffer.from(buf));
    } else if (upstream.body) {
      reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    // If the abort fired, the AbortError landed here — that's expected, not an
    // upstream failure.
    if (controller.signal.aborted) {
      log("client disconnected; upstream fetch aborted");
      return;
    }
    // If we've already begun streaming the upstream body to the client, the
    // response headers are on the wire and we can't switch to a JSON error.
    // This is the common cross-provider failure (e.g. the upstream stream
    // terminates with UND_ERR_BODY_TIMEOUT after the subagent hands back to the
    // main agent). End the partial response here instead of re-throwing into the
    // outer handler, which would try to set headers and crash the daemon.
    if (res.headersSent) {
      log(`upstream stream failed mid-response: ${err.message}`);
      if (!res.writableEnded) res.destroy();
      return;
    }
    // Nothing sent yet — let the outer handler emit a clean JSON error.
    throw err;
  } finally {
    req.off("close", onClientClose);
    if (reader) reader.cancel().catch(() => {});
  }
}

export async function createRouter({ token }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A per-run router token is required");
  let cfg = await loadConfig();
  const reload = async () => {
    try { cfg = await loadConfig(); } catch (err) { log("config reload failed:", err.message); }
  };

  const server = createServer(async (req, res) => {
    await reload();
    try {
      const url = new URL(req.url, "http://localhost");
      log(`<- ${req.method} ${url.pathname} (ua=${(req.headers["user-agent"] || "").slice(0, 40)})`);
      if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")) {
        if (!(await isAuthorizedLocalRequest(req.headers, token))) return sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: "Missing or invalid local router token" } });
        return await handleMessages(req, res, cfg, url.pathname);
      }
      // count_tokens runs the same provider routing as /v1/messages and is intended
      // for the anthropic-passthrough path. A model that resolves to a non-Anthropic
      // provider (e.g. ollama-local) will forward to a backend with no such endpoint.
      if (req.method === "GET" && url.pathname === "/openclaude/status") {
        if (!(await isAuthorizedLocalRequest(req.headers, token))) return sendJson(res, 401, { error: "unauthorized" });
        return sendJson(res, 200, { ok: true, providers: Object.keys(cfg.providers ?? {}) });
      }
      // HEAD / is Claude Code's reachability probe — answer 200.
      if (req.method === "HEAD" || (req.method === "GET" && url.pathname === "/")) {
        res.statusCode = 200;
        return res.end();
      }
      log(`!! 404 for ${req.method} ${url.pathname}`);
      sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `No route for ${req.method} ${url.pathname}` } });
    } catch (err) {
      log("error:", err);
      // sendJson() is a no-op when headers were already sent, and is wrapped so
      // that even an unexpected failure here can never reject the request
      // handler's promise and take the daemon down with it.
      try {
        const status = err.httpStatus ?? 500;
        sendJson(res, status, { type: "error", error: { type: "router_error", message: err.message } });
      } catch (sendErr) {
        log("failed to send error response:", sendErr.message);
        if (!res.writableEnded) res.destroy();
      }
    }
  });

  return { server, getConfig: () => cfg };
}

export async function startRouter(port = 0, token) {
  // The router runs detached with no supervisor to restart it, so a single
  // unhandled error must not be fatal — otherwise every later request from
  // Claude Code fails with a connection error until the user restarts. Log and
  // keep serving instead of letting Node exit on an unhandled rejection.
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection:", reason instanceof Error ? reason.stack : reason);
  });
  process.on("uncaughtException", (err) => {
    log("uncaughtException:", err?.stack ?? err);
  });

  const { server } = await createRouter({ token });
  const listenPort = port ?? 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  log(`listening on http://127.0.0.1:${actualPort}`);
  return { server, port: actualPort };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.error("The router is an internal per-session service; launch it through openclaude run.");
  process.exit(2);
}
