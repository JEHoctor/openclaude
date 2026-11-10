import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedLocalRequest } from "../src/router/auth.js";

test("per-run router authentication accepts only the in-memory session token", () => {
  const token = "a".repeat(64);
  assert.equal(isAuthorizedLocalRequest({}, token), false);
  assert.equal(isAuthorizedLocalRequest({ "x-openclaude-token": "b".repeat(64) }, token), false);
  assert.equal(isAuthorizedLocalRequest({ "x-openclaude-token": token }, token), true);
});
