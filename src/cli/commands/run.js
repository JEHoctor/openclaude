import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../router/config.js";
import { startRouter } from "../../router/index.js";
import { listLocalOllamaModels } from "../ollama.js";\nimport { resolveSubagentModel } from "./model-subagent.js";\nimport { resolveInternalClassifierModel } from "./model-internal-classifier.js";

function describe(model) {
  return "Local Ollama · " + (model.parameter_size ?? "") + " " + (model.family ?? "");
}

export async function run(args) {
  const cfg = await loadConfig();
  const ollamaProvider = cfg.providers?.["ollama-local"];
  const baseUrl = ollamaProvider?.baseUrl || "http://127.0.0.1:11434";
  const installed = await listLocalOllamaModels(baseUrl);
  const allowlist = new Set(cfg.ollamaAllowedModels ?? []);
  const models = installed.filter((model) => allowlist.has(model.name));
  for (const name of allowlist) {
    if (!installed.some((model) => model.name === name)) console.error("[openclaude] WARNING: allowlisted model " + name + " is not installed at " + baseUrl);
  }

  const token = randomBytes(32).toString("hex");
  const router = await startRouter(0, token);
  const env = { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:" + router.port };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  const customHeaders = (env.ANTHROPIC_CUSTOM_HEADERS || "").split(/\r?\n/).filter((line) => line.split(":", 1)[0].trim().toLowerCase() !== "x-openclaude-token");
  customHeaders.push("x-openclaude-token: " + token);
  env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.filter(Boolean).join("\n");

  if (models[0]) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = "ollama-local:" + models[0].name;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = models[0].name + " (Ollama)";
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = describe(models[0]);
  }
  for (const model of models.slice(1)) console.error("[openclaude] Additional allowlisted model: /model ollama-local:" + model.name);
  console.error("[openclaude] private session router: http://127.0.0.1:" + router.port);
  console.error("[openclaude] allowlisted Ollama models: " + (models.map((m) => m.name).join(", ") || "(none)"));

  const subagent = resolveSubagentModel(cfg.subagentModel, models, cfg);\n  if (subagent.warning) console.error("[openclaude] WARNING: " + subagent.warning);\n  if (subagent.envValue) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent.envValue;\n  const classifier = resolveInternalClassifierModel(cfg.internalClassifierModel, models, cfg);\n  if (classifier.warning) console.error("[openclaude] WARNING: " + classifier.warning);\n  if (classifier.envValue) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = classifier.envValue;\n\n  const child = spawn("claude", args, { stdio: "inherit", env });
  let closing = false;
  const closeRouter = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => router.server.close(resolve));
  };
  const onSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  child.once("error", async (error) => {
    console.error("[openclaude] unable to launch claude: " + error.message);
    await closeRouter();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.exitCode = 127;
  });
  child.once("exit", async (code, signal) => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await closeRouter();
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}
