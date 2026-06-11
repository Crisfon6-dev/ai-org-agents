# AI Org Agents

A config-driven multi-agent organizational system for small teams. Deploy a full AI team — Founder, CTO, Marketer, PO, and Coder — that collaborates via Discord, learns from your project's knowledge base, and iterates on tasks autonomously.

## Architecture

```
You → #ai-team-input (Discord)
         ↓
    Founder Agent (Orchestrator)
    ├── Classifies: intent + complexity
    ├── Routes to the right specialist
    ├── For complex tasks: decomposes into a plan and executes iteratively
    └── Consolidates results → #ai-team-output
         ↓
   ┌─────────────────────────────────────────┐
   │  CTO  │  Marketer  │  PO  │  Coder      │
   │  (each specialist has its own channel)  │
   └─────────────────────────────────────────┘
         ↓
   Project Brain (Obsidian vault)
   Each agent reads AND writes — shared org memory
```

**Key design principles:**
- **Config-driven**: add a new agent with 1 YAML block + 1 prompt file — no code changes
- **Transport-agnostic**: Discord by default, swap to Slack/Telegram/CLI via config
- **Adaptive model routing**: cheap models for simple tasks, premium for complex — cost-optimized
- **Quality harness**: detects and flags hallucinated action claims (when agents claim to have done things they can't)
- **Agentic loops**: Founder decomposes complex tasks and iterates with the team until completion

## Prerequisites

- Node.js 20+
- `npm`
- [OpenRouter](https://openrouter.ai) API key (free tier works with $10+ in account)
- Discord application + bot token (or use CLI mode without Discord)
- (Optional) [Hermes agent](https://hermes-agent.nousresearch.com) for code execution

## Quickstart

**1. Install dependencies**
```bash
cd agents && npm install
```

**2. Copy and configure**
```bash
cp config.example.yaml config.yaml
cp env.example .env
# Edit config.yaml with your project details, brain path, and Discord channels
# Edit .env with your API keys (dotenv loads .env — NOT .env.agents)
```

**3. Customize prompts**
```bash
# Edit agents/prompts/*.md — replace [YOUR_PROJECT_NAME] and stack details
# See agents/prompts/examples/aphrodite/ for a complete real-world example
```

**4. (Optional) Set up Discord**
- Create a Discord application at https://discord.com/developers/applications
- Enable Message Content Intent under Bot settings
- Create channels: `ai-team-input`, `ai-team-output`, `cto-channel`, `marketing-channel`, `po-channel`, `dev-channel`, `agent-logs`
- Add bot token and channel IDs to `.env`

**5. Run**
```bash
# With Discord:
npm start

# Without Discord (CLI mode for testing):
npm run start:cli
```

## Configuration

See `config.example.yaml` for full documentation of all options.

### Key settings

| Setting | Description |
|---------|-------------|
| `workspace` | Path to your project root (relative to `agents/`) |
| `project.name` | Your project name (shown in logs and OpenRouter headers) |
| `brain.path` | Path to your knowledge vault (Obsidian or any markdown folder) |
| `agents.<name>.uses_hermes` | Set `true` for the Coder agent to enable code execution |

### Adding a new agent

1. Add a block to `config.yaml`:
```yaml
agents:
  devops:
    role: specialist
    prompt: ./prompts/devops.md
    model_default: meta-llama/llama-3.3-70b-instruct:free
    model_deep: deepseek/deepseek-v4-pro
    discord_channel: devops-channel
    can_write_brain: true
```

2. Create `agents/prompts/devops.md` with the agent's expertise and behavior.

That's it. No TypeScript changes needed.

## Discipline Skills

Agents can be specialized with **Agent Skills** (standard `SKILL.md` format). One canonical source, three consumers:

| Consumer | How it loads skills |
|----------|---------------------|
| Claude Code | Natively from `.claude/skills/` |
| Org agents (this runtime) | Injected into the system prompt as `## Skills de disciplina` (truncated to `skills.max_context_tokens`) |
| Hermes (Coder execution) | Natively via `--skills` flag — requires symlink sync (below) |

Skills live in the repo at `.claude/skills/aphrodite-<discipline>/SKILL.md` (versioned, single source of truth). Map them per agent in `config.yaml`:

```yaml
skills:
  path: ../.claude/skills
  max_context_tokens: 2000

agents:
  cto:
    skills: [aphrodite-backend, aphrodite-infra]
```

Agents without a `skills` field operate exactly as before. Missing or invalid skills log a warning and are skipped — never fatal at startup.

**Hermes sync (per machine):**

```bash
./scripts/sync-hermes-skills.sh           # symlink aphrodite-* skills into ~/.hermes/skills/aphrodite
./scripts/sync-hermes-skills.sh --remove  # rollback (delete symlinks)
hermes skills list                        # verify
```

The script is idempotent — re-run it whenever a new skill is added. Symlinks are per-machine and regenerable; the repo remains the source of truth.

### Self-improvement loop (LEARNINGS.md → curated promotion)

After each completed execution (Coder's Hermes loop, Founder's agentic plan), a cheap-model **gap-capture pass** asks "what domain knowledge was missing?" and, if something surfaced:

1. Appends a dated entry to `.claude/skills/<skill>/LEARNINGS.md` (staging — automatic).
2. Mirrors the entry to the brain (`wiki/analysis/<role>-decisions-<date>.md`, tag `skill-gap`).

A failed capture never affects the main task (warning only).

**Promotion is human-curated, at each wave retro** — never automatic:

1. Review each `LEARNINGS.md` entry.
2. **Promote**: integrate into the SKILL.md body (keep it < 300 lines and within token budget), then delete the entry from staging.
3. **Discard**: remove the entry, leaving a one-line reason (or move it to the brain if it's worth keeping as history).
4. Re-run `./scripts/sync-hermes-skills.sh` is NOT needed (symlinks point at the dirs), but restart the org so agents reload skill context.

Scope rule: **domain** gaps (conventions, paths, repo patterns) go to skill LEARNINGS; **role identity/format** gaps go to `prompts/examples/aphrodite/<rol>.md` (see openspec change `agent-org-functional-completion`).

## Cost Optimization

The system uses adaptive model routing with 3 tiers per agent:

| Tier | Trigger | Recommended model |
|------|---------|-------------------|
| `model_fast` | Simple questions, routing | `deepseek/deepseek-v4-flash` |
| `model_default` | Standard analysis, creative tasks | `meta-llama/llama-3.3-70b-instruct:free` |
| `model_deep` | Complex architecture decisions | `deepseek/deepseek-v4-pro` |
| `model_vision` | Messages with image attachments | `google/gemma-4-31b-it:free` |

When `:free` models hit upstream rate limits, the system automatically retries with the paid version of the same model (same quality, minimal cost increase).

**Estimated daily cost with $10 in account:** < $0.05 for intensive use (most calls use free tier).

## Examples

See `agents/prompts/examples/aphrodite/` for a complete real-world deployment on a creator marketplace platform — including domain-specific CTO, Marketer, PO, and Coder prompts.

## License

MIT — build on it, fork it, deploy it anywhere.
