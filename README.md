# slack-lists-cli-llm

A CLI for interacting with the [Slack Lists API](https://docs.slack.dev/surfaces/lists/) — designed and optimized for LLM coding agents.

## Why This Exists

This CLI is built specifically for AI coding agents (Claude, GPT, Codex, etc.) to interact with Slack Lists for task management, status updates, and team communication. Unlike general-purpose Slack tools, every design decision prioritizes machine readability and agent workflows.

## Optimized for Coding Agents

| Feature | Why It Matters for Agents |
|---------|---------------------------|
| **JSON-only output** | All commands return structured JSON — no human-formatted tables or colored output that breaks parsing |
| **Predictable error format** | Errors return `{"ok": false, "error": "...", "details": {...}}` — agents can programmatically handle failures |
| **Explicit IDs over names** | Commands accept and return Slack IDs to avoid ambiguity and resolution failures |
| **No interactive prompts** | Every command is fully non-interactive — no confirmation dialogs or input prompts |
| **Minimal dependencies** | Fast startup time for frequent invocations in agent loops |

## Installation

```bash
npm install -g slack-lists-cli-llm
```

## Authentication

Set your Slack token as an environment variable:

```bash
export SLACK_TOKEN=xoxb-your-bot-token
```

Verify authentication:

```bash
slack-lists auth status
# {"ok": true, "user_id": "U...", "team_id": "T...", "team": "workspace-name"}
```

### Required Scopes

Your Slack app needs these OAuth scopes:

- `lists:read` — Read lists and items
- `lists:write` — Create/update/delete items
- `chat:write` — Post messages (for comments)
- `users:read` — Resolve user references
- `files:write` — Upload file attachments

## Commands

### List Operations

```bash
# List all accessible lists
slack-lists lists

# Get list details including schema (columns, field types)
slack-lists lists info <list-id>

# Export list data
slack-lists lists export <list-id> --format json
```

### Item Operations

```bash
# List items (with optional filters)
slack-lists items list <list-id>
slack-lists items list <list-id> --filter "status=pending"

# Get single item
slack-lists items get <list-id> <item-id>

# Create item (requires schema-aware field mapping)
slack-lists items create <list-id> --cells '{"column_id": {"value": "..."}}'

# Update item
slack-lists items update <list-id> <item-id> --cells '{"column_id": {"value": "..."}}'

# Delete item
slack-lists items delete <list-id> <item-id>
```

### Schema Discovery

Before creating or updating items, fetch the list schema to get column IDs and valid option values:

```bash
slack-lists lists info <list-id>
# Returns columns with IDs, types, and options for select fields
```

## Output Format

All commands output JSON to stdout. Errors output JSON to stderr with exit code 1.

**Success:**
```json
{
  "ok": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "ok": false,
  "error": "invalid_list_id",
  "details": { "list_id": "L123" }
}
```

## Agent Integration Examples

### Claude Code / Agentic Workflows

```bash
# Agent discovers available lists
LISTS=$(slack-lists lists)

# Agent gets schema to understand fields
SCHEMA=$(slack-lists lists info L123456)

# Agent creates a task item using correct column IDs from schema
slack-lists items create L123456 --cells '{"col_abc": {"text": "Implement feature X"}}'

# Agent updates status when done
slack-lists items update L123456 I789 --cells '{"col_status": {"select": "opt_done"}}'
```

### MCP Server Integration

This CLI can be wrapped as an MCP (Model Context Protocol) server to give Claude direct access to Slack Lists without shell execution.

## Development

```bash
git clone https://github.com/mercury-labs/slack-lists-cli-llm.git
cd slack-lists-cli-llm
npm install
npm run build
npm link  # Makes 'slack-lists' available globally for testing
```

## Current Status

**Work in Progress** — This CLI is under active development.

### Implemented
- [ ] Core infrastructure (CLI framework, Slack client wrapper)
- [ ] Authentication (`auth status`)
- [ ] List operations (`lists`, `lists info`, `lists export`)
- [ ] Item operations (`items list`, `items get`, `items create`, `items update`, `items delete`)

### Planned
- [ ] Schema-aware field mapping helpers
- [ ] Pagination handling for large lists
- [ ] Rate limit handling with backoff

### Under Investigation
- [ ] Comments on items (requires understanding item thread model)
- [ ] File attachments (evidence) on items

## Requirements

- Node.js 18+
- Paid Slack workspace (Lists API requirement)
- Slack app with appropriate scopes

## License

MIT
