import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config.js";

const TOKEN_FILE = join(paths.dir, "router.token");

export async function loadRouterToken() {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700).catch(() => {});
  try {
    const token = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(token)) {
      await chmod(TOKEN_FILE, 0o600).catch(() => {});
      return token;
    }
  } catch {}
  const token = randomBytes(32).toString("hex");
  try {
    const handle = await open(TOKEN_FILE, "wx", 0o600);
    try { await handle.writeFile(token + "\n", "utf8"); } finally { await handle.close(); }
    return token;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const existing = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error("Invalid router token file");
    await chmod(TOKEN_FILE, 0o600).catch(() => {});
    return existing;
  }
}

export async function isAuthorizedLocalRequest(headers) {
  const expected = await loadRouterToken();
  const supplied = headers["x-openclaude-token"];
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
