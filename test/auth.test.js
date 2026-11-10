import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("router token is generated, persisted, and reused with private permissions", async () => {
  const home = join(tmpdir(), "oc-test-token-" + Date.now());
  const oldHome = process.env.OPENCLAUDE_HOME;
  try {
    process.env.OPENCLAUDE_HOME = home;
    const { loadRouterToken } = await import("../src/router/auth.js?" + Date.now());
    const token = await loadRouterToken();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(await loadRouterToken(), token);
    assert.equal((await readFile(join(home, "router.token"), "utf8")).trim(), token);
    assert.equal((await stat(join(home, "router.token"))).mode & 0o777, 0o600);
    const auth = await import("../src/router/auth.js");
    assert.equal(await auth.isAuthorizedLocalRequest({}), false);
    assert.equal(await auth.isAuthorizedLocalRequest({ "x-openclaude-token": "wrong" }), false);
    assert.equal(await auth.isAuthorizedLocalRequest({ "x-openclaude-token": token }), true);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
