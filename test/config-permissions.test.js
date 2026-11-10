import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("config directory and file permissions are restricted on creation and load", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission bits are not enforced on Windows");
  const home = await mkdtemp(join(tmpdir(), "openclaude-permissions-"));
  const configDir = join(home, "private-config");
  const previousHome = process.env.OPENCLAUDE_HOME;
  process.env.OPENCLAUDE_HOME = configDir;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const config = await import("../src/router/config.js?permissions-test");
  await config.ensureConfig();
  assert.equal((await stat(config.paths.dir)).mode & 0o777, 0o700);
  assert.equal((await stat(config.paths.file)).mode & 0o777, 0o600);

  await chmod(config.paths.dir, 0o755);
  await chmod(config.paths.file, 0o644);
  await config.loadConfig();
  assert.equal((await stat(config.paths.dir)).mode & 0o777, 0o700);
  assert.equal((await stat(config.paths.file)).mode & 0o777, 0o600);

  await chmod(config.paths.file, 0o644);
  await config.saveConfig({ defaultProvider: "claude", providers: {} });
  assert.equal((await stat(config.paths.file)).mode & 0o777, 0o600);
});
