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
cp env.example .env.agents
# Edit config.yaml with your project details, brain path, and Discord channels
# Edit .env.agents with your API keys
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
- Add bot token and channel IDs to `.env.agents`

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

## Cost Optimization

The system uses adaptive model routing with 3 tiers per agent:

| Tier | Trigger | Recommended model |
|------|---------|-------------------|
| `model_fast` | Simple questions, routing | `deepseek/deepseek-v4-flash` |
| `model_default` | Standard analysis, creative tasks | `meta-llama/llama-3.3-70b-instruct:free` |
| `model_deep` | Complex architecture decisions | `deepseek/deepseek-v4-pro` |

When `:free` models hit upstream rate limits, the system automatically retries with the paid version of the same model (same quality, minimal cost increase).

**Estimated daily cost with $10 in account:** < $0.05 for intensive use (most calls use free tier).

## Examples

See `agents/prompts/examples/aphrodite/` for a complete real-world deployment on a creator marketplace platform — including domain-specific CTO, Marketer, PO, and Coder prompts.

## License

MIT — build on it, fork it, deploy it anywhere.
