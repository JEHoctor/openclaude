import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Upstream stub sends SSE headers + a partial chunk, then abruptly destroys
// the socket. This reproduces an upstream stream ending after forwarding began.
function startStub(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof body.model === "string" && body.model.includes("diemid")) {
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.write("event: message_start\\ndata: {}\\n\\n");
          setTimeout(() => res.socket.destroy(), 50);
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }] }));
      });
    });
    server.listen(port, "127.0.0.1", () => resolve({ server }));
  });
}

test("router survives an upstream error that occurs after streaming has started", async (t) => {
  const home = join(tmpdir(), `oc-stream-err-${Date.now()}-${process.pid}`);
  await mkdir(home, { recursive: true });
  const previousHome = process.env.OPENCLAUDE_HOME;
  process.env.OPENCLAUDE_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const STUB_PORT = 19992;
  const { server: stub } = await startStub(STUB_PORT);
  t.after(() => new Promise((resolve) => stub.close(resolve)));

  const cfg = {
    defaultProvider: "fake-anthropic",
    providers: {
      "fake-anthropic": { type: "anthropic-passthrough", baseUrl: `http://127.0.0.1:${STUB_PORT}` },
    },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg, null, 2));

  // The router is an in-process per-session service, not a standalone daemon.
  // Exercise its exported startup API with the same capability-token auth used
  // by the wrapper-created Claude Code child environment.
  const { startRouter } = await import("../src/router/index.js");
  const token = randomBytes(32).toString("hex");
  const router = await startRouter(0, token);
  t.after(() => new Promise((resolve) => {
    router.server.close(resolve);
    router.server.closeAllConnections?.();
  }));
  const url = `http://127.0.0.1:${router.port}`;
  const headers = { "content-type": "application/json", "x-openclaude-token": token };

  const status = await fetch(url + "/openclaude/status", { headers });
  assert.equal(status.status, 200);

  // Request #1 triggers a mid-stream upstream death. The client may see a
  // truncated body; the router itself must remain healthy.
  try {
    const r1 = await fetch(url + "/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "diemid-model", messages: [{ role: "user", content: "hi" }] }),
    });
    await r1.text().catch(() => {});
  } catch {
    // A network-level abort of the partial stream is acceptable.
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  // A subsequent request must still be routed successfully.
  const r2 = await fetch(url + "/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r2.status, 200, "router must keep serving requests after a mid-stream upstream error");
});
