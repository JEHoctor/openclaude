import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startStub() {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        seen.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

test("router e2e: ephemeral token auth, OAuth pass-through, no leak across providers", async (t) => {
  const home = join(tmpdir(), "oc-test-" + Date.now());
  await mkdir(home, { recursive: true });
  const oldHome = process.env.OPENCLAUDE_HOME;
  process.env.OPENCLAUDE_HOME = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  const { server: stub, seen, port: stubPort } = await startStub();
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  await writeFile(join(home, "config.json"), JSON.stringify({
    defaultProvider: "fake-anthropic",
    providers: {
      "fake-anthropic": { type: "anthropic-passthrough", baseUrl: "http://127.0.0.1:" + stubPort },
      "fake-ollama": { type: "ollama", baseUrl: "http://127.0.0.1:" + stubPort },
      "ollama-local": { type: "ollama", baseUrl: "http://127.0.0.1:" + stubPort },
    },
    ollamaAllowedModels: ["qwen2.5:7b", "gemma4:31b-cloud"],
  }));

  const { startRouter } = await import("../src/router/index.js");
  const token = "a".repeat(64);
  const router = await startRouter(0, token);
  const url = "http://127.0.0.1:" + router.port;
  t.after(() => new Promise((resolve) => router.server.close(resolve)));

  const denied = await fetch(url + "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", messages: [] }),
  });
  assert.equal(denied.status, 401);

  const r1 = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { "x-openclaude-token": token, "content-type": "application/json", authorization: "Bearer my-oauth-token" },
    body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 200);
  assert.equal(seen.at(-1).body.model, "sonnet");
  assert.equal(seen.at(-1).headers.authorization, "Bearer my-oauth-token");

  const r2 = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { "x-openclaude-token": token, "content-type": "application/json", authorization: "Bearer should-not-leak" },
    body: JSON.stringify({ model: "fake-ollama:gemma4:31b-cloud", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r2.status, 200);
  assert.equal(seen.at(-1).body.model, "gemma4:31b-cloud");
  assert.ok(seen.at(-1).headers["x-api-key"]);
  assert.notEqual(seen.at(-1).headers.authorization, "Bearer should-not-leak");

  const blocked = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { "x-openclaude-token": token, "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama-local:unlisted:latest", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(blocked.status, 403);

  const allowed = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { "x-openclaude-token": token, "content-type": "application/json" },
    body: JSON.stringify({ model: "ollama-local:qwen2.5:7b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(seen.at(-1).body.model, "qwen2.5:7b");

  const discovery = await fetch(url + "/v1/models");
  assert.equal(discovery.status, 404);
});
