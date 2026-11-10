import { timingSafeEqual } from "node:crypto";

export function isAuthorizedLocalRequest(headers, expectedToken) {
  const supplied = headers["x-openclaude-token"];
  if (typeof expectedToken !== "string" || typeof supplied !== "string" || supplied.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedToken));
}
