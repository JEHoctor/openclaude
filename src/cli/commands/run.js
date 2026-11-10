import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../router/config.js";
import { startRouter } from "../../router/index.js";
import { listLocalOllamaModels } from "../ollama.js";
import { resolveSubagentModel } from "./model-subagent.js";
import { resolveInternalClassifierModel } from "./model-internal-classifier.js";

function describe(model) {
  const details = [model.parameter_size, model.family].filter(Boolean).join(" ");
  return details ? "Local Ollama · " + details : "Local Ollama model";
}

/** Build a child-only environment; the caller environment is never mutated. */
export function createClaudeEnvironment(parentEnv, port, token, models, cfg) {
  const env = { ...parentEnv, ANTHROPIC_BASE_URL: "http://127.0.0.1:" + port };
  // Force Claude Code to use its own logged-in subscription session.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  // Claude Code otherwise treats a custom ANTHROPIC_BASE_URL as a third-party
  // provider and drops subscription OAuth. Explicitly trust only this exact
  // loopback host:port for this child process.
  const proxyHosts = new Set(String(env.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS || "").split(",").map((host) => host.trim()).filter(Boolean));
  proxyHosts.add("127.0.0.1:" + port);
  env.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS = [...proxyHosts].join(",");

  // Replace only our private header; preserve unrelated custom headers.
  const customHeaders = String(env.ANTHROPIC_CUSTOM_HEADERS || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      const separator = line.indexOf(":");
      const name = separator < 0 ? "" : line.slice(0, separator).trim();
      return name.toLowerCase() !== "x-openclaude-token";
    });
  customHeaders.push("x-openclaude-token: " + token);
  env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.join("\n");

  // Never inherit a stale custom picker binding when no model is allowed.
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION;
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME;
  delete env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION;
  if (models[0]) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = "ollama-local:" + models[0].name;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = models[0].name + " (Ollama)";
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = describe(models[0]);
  }

  const subagent = resolveSubagentModel(cfg.subagentModel, models, cfg);
  if (subagent.envValue) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent.envValue;
  else if (cfg.subagentModel) delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  const classifier = resolveInternalClassifierModel(cfg.internalClassifierModel, models, cfg);
  if (classifier.envValue) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = classifier.envValue;
  else if (cfg.internalClassifierModel) delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  return { env, warnings: [subagent.warning, classifier.warning].filter(Boolean) };
}

export async function run(args) {
  const cfg = await loadConfig();
  const baseUrl = cfg.providers?.["ollama-local"]?.baseUrl || "http://127.0.0.1:11434";
  const installed = await listLocalOllamaModels(baseUrl);
  const allowlist = new Set(cfg.ollamaAllowedModels ?? []);
  const models = installed.filter((model) => allowlist.has(model.name));
  for (const name of allowlist) {
    if (!installed.some((model) => model.name === name)) {
      console.error("[openclaude] WARNING: allowlisted model " + name + " is not installed at " + baseUrl);
    }
  }

  // A fresh, unpersisted capability token and port for every invocation.
  const token = randomBytes(32).toString("hex");
  const router = await startRouter(0, token);
  const { env, warnings } = createClaudeEnvironment(process.env, router.port, token, models, cfg);
  for (const warning of warnings) console.error("[openclaude] WARNING: " + warning);
  for (const model of models.slice(1)) {
    console.error("[openclaude] Additional allowlisted model: /model ollama-local:" + model.name);
  }
  console.error("[openclaude] private session router listening on 127.0.0.1:" + router.port);
  console.error("[openclaude] allowlisted Ollama models: " + (models.map((m) => m.name).join(", ") || "(none)"));

  let child;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal) => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const closeRouter = async () => {
    await new Promise((resolve) => {
      router.server.close(resolve);
      // Do not let an idle keep-alive socket keep the wrapper alive after the
      // Claude child has exited. Active requests are allowed to finish.
      router.server.closeIdleConnections?.();
    });
    router.server.closeAllConnections?.();
  };

  for (const signal of signals) process.on(signal, onSignal);
  try {
    child = spawn("claude", args, { stdio: "inherit", env });
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("error", (error) => {
        console.error("[openclaude] unable to launch claude: " + error.message);
        process.exitCode = 127;
        finish();
      });
      child.once("exit", (code, signal) => {
        process.exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1);
        finish();
      });
    });
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    await closeRouter();
  }
}
