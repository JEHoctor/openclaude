import { run } from "./commands/run.js";
import { modelSubagent } from "./commands/model-subagent.js";
import { modelInternalClassifier } from "./commands/model-internal-classifier.js";

const HELP = `openclaude — multi-provider router for Claude Code

Usage:
  openclaude run [claude args...]        Run Claude Code with isolated OpenClaude routing
  openclaude shell-init                  Print a bash/zsh alias for oclaude
  openclaude model-subagent              Show/select subagent model for Claude Code
  openclaude model-subagent <n>          Set subagent model for the next run
  openclaude internal-classifier         Show/select Claude Code background model

Notes:
  - The normal claude command is unaffected.
  - Each run uses a fresh localhost port and an in-memory random router token.
  - Only exact model names in ollamaAllowedModels in ~/.openclaude/config.json are exposed and routed.
  - The first allowlisted model appears in the Custom picker slot; additional models can be selected by name.

Config: ~/.openclaude/config.json
`;

const COMMANDS = {
  run,
  "shell-init": () => console.log(`alias oclaude="openclaude run"`),
  "model-subagent": modelSubagent,
  "internal-classifier": modelInternalClassifier,
  help: () => console.log(HELP),
};

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}
const handler = COMMANDS[cmd];
if (!handler) {
  console.error("unknown command: " + cmd + "\\n");
  console.error(HELP);
  process.exit(2);
}
try {
  await handler(rest);
} catch (err) {
  console.error("error: " + err.message);
  if (process.env.OPENCLAUDE_DEBUG) console.error(err.stack);
  process.exit(1);
}
