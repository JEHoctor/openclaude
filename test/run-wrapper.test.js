import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeEnvironment } from "../src/cli/commands/run.js";

const cfg = {
  defaultProvider: "claude",
  providers: {
    claude: { type: "anthropic-passthrough", baseUrl: "https://api.anthropic.com" },
    "ollama-local": { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
  },
  ollamaAllowedModels: [],
};

test("wrapper isolates routing and token to child environment", () => {
  const parent = {
    PATH: "/usr/bin",
    ANTHROPIC_AUTH_TOKEN: "inherited-token",
    ANTHROPIC_API_KEY: "inherited-key",
    ANTHROPIC_CUSTOM_HEADERS: "x-user-header: keep\\nx-openclaude-token: stale",
  };
  const models = [{ name: "qwen2.5:7b", family: "qwen", parameter_size: "7B" }];
  const { env } = createClaudeEnvironment(parent, 43210, "a".repeat(64), models, cfg);

  assert.equal(parent.ANTHROPIC_AUTH_TOKEN, "inherited-token", "parent environment must not be mutated");
  assert.equal(parent.ANTHROPIC_API_KEY, "inherited-key");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43210");
  assert.equal(env.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS, "127.0.0.1:43210");
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-user-header: keep/);
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS, new RegExp("x-openclaude-token: " + "a".repeat(64)));
  assert.equal((env.ANTHROPIC_CUSTOM_HEADERS.match(/x-openclaude-token:/g) || []).length, 1);
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, "ollama-local:qwen2.5:7b");
});

test("wrapper does not expose an inherited custom model when allowlist is empty", () => {
  const parent = { ANTHROPIC_CUSTOM_MODEL_OPTION: "ollama-local:unlisted" };
  const { env } = createClaudeEnvironment(parent, 43211, "b".repeat(64), [], cfg);
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
});

test("wrapper adds its loopback endpoint to existing first-party proxy hosts", () => {
  const parent = { ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: "localhost:1234,127.0.0.1:99" };
  const { env } = createClaudeEnvironment(parent, 43212, "c".repeat(64), [], cfg);
  assert.equal(env.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS, "localhost:1234,127.0.0.1:99,127.0.0.1:43212");
});
