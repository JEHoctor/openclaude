# openclaude

[![npm version](https://img.shields.io/npm/v/@aliildan/openclaude.svg)](https://www.npmjs.com/package/@aliildan/openclaude)
[![node](https://img.shields.io/node/v/@aliildan/openclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **One Claude Code session, every model.** Keep your Anthropic Claude subscription for the main chat and route subagents, background tasks, or whole conversations to **local or cloud Ollama** models — all from the same `/model` picker, without leaving Claude Code.

openclaude is a small wrapper around the `claude` CLI. The ordinary `claude` command is untouched; `openclaude run` starts an isolated Claude Code process with a per-run local router, a fresh in-memory authentication token, and only the Ollama models you explicitly allowlist.

![openclaude /model picker screenshot](openclaude.png)

## Quickstart

**Requirements:** [Claude Code](https://claude.com/claude-code) ≥ v2.1.129 (logged in), [Node.js](https://nodejs.org) ≥ 20, and — optionally — [Ollama](https://ollama.com/download) if you want to route to Ollama models.

```bash
# 1. Install
npm install -g @aliildan/openclaude

# 2. Run once to create ~/.openclaude/config.json, then exit Claude Code
openclaude run

# 3. Pull the model you intend to expose and add its exact name to config
ollama pull qwen2.5-coder:7b
# Edit ~/.openclaude/config.json: "ollamaAllowedModels": ["qwen2.5-coder:7b"]

# 4. Launch the wrapped session
openclaude run

# Optional: print the alias line to add to ~/.bashrc or ~/.zshrc
openclaude shell-init
```

<!-- QUICKSTART_END -->

<!--
#    "ollamaAllowedModels": ["qwen2.5-coder:7b"]

`openclaude run` starts a private router on an ephemeral localhost port, generates a random per-session token in memory, and launches `claude` with only the wrapper-specific environment overrides. The router is shut down when Claude exits. `openclaude shell-init` prints `alias oclaude="openclaude run"`; add that line to your shell rc file and use `oclaude` when you want the wrapped session. The regular `claude` command remains unchanged.

Upgrade any time with `npm install -g @aliildan/openclaude@latest`. The package is scoped (`@aliildan/openclaude`), but the commands stay `oc` / `openclaude`, and `openclaude run` works from any directory on Linux, macOS, and Windows.

## Features

- **🔌 Keep your Claude subscription** — Claude Code's OAuth bearer is forwarded to `api.anthropic.com` untouched. No `ANTHROPIC_API_KEY` required.
- **🧩 Explicit Ollama allowlist** — only exact model names in `ollamaAllowedModels` are visible and routable in the wrapped session.
- **☁️ Frontier open-weight models without a GPU** — route to [Ollama Cloud](https://ollama.com/cloud) (`gpt-oss:120b`, `qwen3:480b`, `deepseek-v3.1:671b`, `kimi-k2:1t`, …) through the same workflow.
- **💸 Cheap subagents** — send the Explore / Plan / general-purpose subagents to a local model while your main conversation stays on Anthropic Claude.
- **🛡️ Cross-provider safety** — sanitizes tool-use ids, thinking-block signatures, images, and malformed SSE streams so switching models mid-conversation just works.
- **🪶 Thin & local** — single-file Node.js ESM, no build step, bound to `127.0.0.1`.

## How it works

```
┌──────────────┐  ANTHROPIC_BASE_URL      ┌────────────────────┐
│ claude (CLI) │ ────────────────────────►│ openclaude router  │
│  /model      │  Authorization passed    │  ephemeral 127.0.0.1 port   │
└──────────────┘  through                 └─────────┬──────────┘
                                                    │ parse "provider:modelId"
                                  ┌─────────────────┼─────────────────┐
                                  ▼                 ▼                 ▼
                       api.anthropic.com    localhost:11434      ollama.com
                       (your OAuth)         (no auth)            (x-api-key)
```

When you select a model in `/model`:
- Picker entry **`Default` / `Sonnet` / `Opus` / `Haiku`** → routed to **real Anthropic** via your subscription.
- Only models explicitly allowlisted in `ollamaAllowedModels` can be selected for local Ollama.
- Picker entry **`<name> (Ollama)`** (the Custom alias slot) → routed to **local Ollama**.
- Anything you type, e.g. `/model ollama-local:gemma4:31b-cloud` → routed by parsing the prefix.

### Authentication and local trust boundary

openclaude does not read Claude Code's credential file or macOS Keychain, and it never substitutes or stores your Anthropic OAuth token. Claude Code authenticates to Anthropic using its own normal subscription session; openclaude forwards those upstream authorization headers unchanged. The wrapper adds its exact `127.0.0.1:<port>` endpoint to `ANTHROPIC_FIRST_PARTY_PROXY_HOSTS`, which tells Claude Code to retain OAuth authentication for this loopback proxy.

Each `openclaude run` creates a router on an ephemeral localhost port and generates a fresh random local-hop token held only in the wrapper and child-process environment. It is supplied to Claude Code using `ANTHROPIC_CUSTOM_HEADERS`; it is not written to disk or forwarded to Anthropic or Ollama. The router closes when the session exits. The normal `claude` process environment and configuration are not modified.

Model discovery is deliberately disabled. Only exact names in `ollamaAllowedModels` are exposed and permitted by the router. The first installed allowlisted model occupies the Custom picker slot; other allowlisted models can be selected with `/model ollama-local:<name>`. The allowlist is enforced server-side too, so manually typing an unlisted model name is rejected.

## Guides

### Subagent model — cheaper background work

Claude Code's Explore, Plan, and general-purpose subagents can be expensive because they read many files and digest verbose output. `openclaude model-subagent` selects an allowlisted local model for subagent traffic to a cheaper model (like a local Ollama model) while keeping your main conversation on Anthropic Claude.

```bash
oc model-subagent          # show current setting + available models
oc model-subagent 2        # select a model by number
oc model-subagent 0        # reset to Anthropic default (or: oc model-subagent default)
```

**How it works:** `openclaude model-subagent` writes a `subagentModel` key to `~/.openclaude/config.json`. On the next `openclaude run`, the router sets `CLAUDE_CODE_SUBAGENT_MODEL` before launching `claude`. Claude Code reads this once at startup, so **changes do not take effect in a running session** — restart the wrapped session to apply them. The numbered menu offers `0` (default/unset), `1..N` (installed Ollama models routed as `ollama-local:<name>`), and Anthropic models (e.g. Haiku, using your subscription). If the configured model is no longer installed at `openclaude run`, the router falls back to the Anthropic default and warns. The selector reports the configured value; it is applied when the next wrapped session starts.

### Ollama model allowlist

The wrapper does not enumerate models into Claude Code's model picker. It reads `ollamaAllowedModels` from `~/.openclaude/config.json`, and the router rejects requests for any Ollama model not named in that array. This applies to configured Ollama providers, including local and cloud endpoints. For local models, entries must exactly match the names returned by Ollama's `/api/tags` endpoint.

### Ollama: local & cloud

**Local Ollama** — the default config assumes Ollama at `http://127.0.0.1:11434`. Since v0.14, Ollama serves the Anthropic Messages API at `/v1/messages` natively, so no translation layer is needed.

```bash
ollama serve &           # if not already running
ollama pull qwen2.5-coder
# Add the exact installed model name to ollamaAllowedModels in config.json
openclaude run
```

**Ollama Cloud** ([ollama.com/cloud](https://ollama.com/cloud)) hosts large open-weight models (200B–1T parameters) behind the same Anthropic-compatible endpoint, so openclaude routes to it identically. Mix your Claude subscription with frontier OSS models like `gpt-oss:120b-cloud`, `qwen3:480b-cloud`, `deepseek-v3.1:671b-cloud`, or `kimi-k2:1t-cloud` — none of which fit on consumer hardware — without leaving Claude Code.

```bash
# Option A — pull cloud models into local Ollama (most common).
# Add the exact model name to `ollamaAllowedModels` before using it through `ollama-local`.
ollama pull gpt-oss:120b-cloud
openclaude run

# Option B — hit ollama.com directly, no local registration.
export OLLAMA_API_KEY=<your-key-from-ollama.com>
openclaude run
# In /model: paste "/model ollama-cloud:<name>"
```

The default config ships `ollama-cloud` with `apiKey: "$OLLAMA_API_KEY"`; the router substitutes the env var at request time. Get a key at [ollama.com](https://ollama.com/cloud).

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `openclaude run [args...]` | Launch Claude Code with isolated routing and per-run credentials. |
| `openclaude shell-init` | Print `alias oclaude='openclaude run'` for bash/zsh rc files. |
| `openclaude model-subagent` | Select an allowlisted model for subagents. |
| `openclaude internal-classifier` | Select an allowlisted model for the internal classifier. |

### Configuration

Config lives at `~/.openclaude/config.json` (auto-seeded on first run). `ollamaAllowedModels` is an exact model-name allowlist applied to every Ollama provider. A local model appears in the Custom picker only when it is both installed locally and listed here; cloud or remote models can be selected manually when their exact model name is listed. Add providers by editing the file:

```json
{
  "defaultProvider": "claude",
  "ollamaAllowedModels": ["qwen2.5-coder:7b"],
  "providers": {
    "claude":        { "type": "anthropic-passthrough", "baseUrl": "https://api.anthropic.com" },
    "ollama-local":  { "type": "ollama", "baseUrl": "http://127.0.0.1:11434" },
    "ollama-cloud":  { "type": "ollama", "baseUrl": "https://ollama.com", "apiKey": "$OLLAMA_API_KEY" },
    "remote-ollama": { "type": "ollama", "baseUrl": "http://192.168.1.50:11434" }
  }
}
```


### Auth model

| Provider type           | Auth                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `anthropic-passthrough` | Claude Code's `Authorization` header is forwarded untouched. No key needed. |
| `ollama` (local)        | None — Ollama ignores the key.                                              |
| `ollama` (cloud)        | `x-api-key: $OLLAMA_API_KEY` (env-var-interpolated).                        |

<details>
<summary><strong>Under the hood</strong> — cross-provider sanitization, image-stripping, SSE fixup, tests</summary>

### Conversation-history sanitization

Cross-provider sessions accumulate metadata that the *next* provider can't validate. Two known cases, both fixed unconditionally on every outgoing request:

1. **Tool-use ids.** Anthropic requires `tool_use.id` to match `^[a-zA-Z0-9_-]+$`. Ollama's compat layer can emit ids with `.`, `:`, or `#`. Claude Code stores those in history and replays them — so when you switch back to a Claude model, Anthropic returns `400 messages.N.content.M.tool_use.id: String should match pattern ...`. The router rewrites dirty ids to `toolu_oc_<sanitized>` form and remaps the matching `tool_result.tool_use_id` so the call/result graph stays coherent.
2. **Thinking-block signatures.** Anthropic cryptographically signs every `thinking` block it emits and validates the signature on replay. Non-Anthropic upstreams (Ollama, our stream-fixup synthesizer) emit thinking blocks with empty or placeholder signatures, which Anthropic later rejects with `400 messages.N.content.M: Invalid signature in thinking block`. The router scans for thinking blocks whose signature looks fake (missing or shorter than ~64 chars) and replaces them with a `[thinking from a prior model omitted]` text marker. Real Anthropic signatures are preserved untouched.

Log lines confirm when either fires: `sanitized N dirty tool_use id(s)` / `dropped N thinking block(s) with non-Anthropic signature`.

### Image-stripping for text-only models

Claude Code re-sends the full conversation history every turn, so an image you attached three turns ago is still in the request when you switch to a text-only model like `gpt-oss:120b-cloud`. Without intervention, that model returns 400 `"this model does not support image input"` and you can't continue.

The router probes each Ollama model's capabilities via `/api/show` (cached in-process), and for models that don't list `vision`, strips `image` content blocks — replacing them with a `[image omitted]` text marker. Vision-capable models are unaffected; nested images inside tool-result blocks are handled too. A startup line `[openclaude] stripped N image block(s) for text-only model X` confirms when this fires.

### SSE stream sanitizer

Ollama's Anthropic-compat layer occasionally emits a `content_block_delta` event for an index it never opened with `content_block_start` — Claude Code's stream parser then aborts with `"Content block not found"` and retries forever (seen on multimodal models like `kimi-k2.6:cloud`). The router wraps every Ollama streaming response in a sanitizer (`src/router/stream-fixup.js`) that tracks open content-block indices, synthesizes the missing `content_block_start` for orphan deltas (matching type — text, thinking, or tool_use with a placeholder id), tracks `content_block_stop` so re-used indices re-synthesize, and passes everything else through byte-for-byte. Anthropic-passthrough responses (real Claude) are never touched.

The per-run router handles upstream stream failures by closing partial responses cleanly; it exits when the wrapped Claude process ends.

### Tests

```bash
npm test
```

Node's built-in test runner covers `parseModelTarget` routing; a real-router-vs-stub e2e (OAuth pass-through, Ollama `x-api-key`, no header leakage, allowlist enforcement); the SSE sanitizer; image stripping; tool-use id + thinking-signature sanitization; subagent-model resolution/config round-trip; and the mid-stream upstream-failure regression.

</details>

## Limitations

- **`tool_choice` forcing isn't supported** by Ollama's Anthropic-compat layer; some models may degrade tool-use behavior.
- **Synthesized `tool_use` blocks** (from an orphan `input_json_delta` with no preceding start) get a placeholder `id` and `name: "unknown"` — the call still executes parser-side but downstream tool routing may fail. Vision/text deltas have no such caveat.
- Only `anthropic-passthrough` and `ollama` provider types are supported today. OpenAI / OpenRouter / Bedrock / Vertex are deferred (the abstraction is ready).

## Status

**v0.1.0** — small Node.js ESM router + CLI, no build step, no runtime dependencies. [MIT licensed](https://opensource.org/licenses/MIT).
