# slack-lists-cli

CLI for agentic coding workflows using Slack Lists. Commands return JSON for agent consumption.

## Why This Exists

This CLI is built specifically for AI coding agents (Claude, GPT, Codex, etc.) to interact with Slack Lists for task management, status updates, and evidence tracking. Unlike general-purpose Slack tools, every design decision prioritizes machine readability and agent workflows.

## Design Principles for Agentic Coding

- JSON-only output with stable shapes for parsing.
- Predictable error format: `{"ok": false, "error": "...", "details": {...}}` on stderr with exit code 1.
- No interactive prompts or confirmations.
- Favors Slack IDs (stable references) over display names.
- Minimal dependencies for fast startup in agent loops.

## Requirements

- Node.js >= 18
- Slack token with lists scopes
- Paid Slack workspace

## Installation

```bash
npm install -g slack-lists-cli
```

## Environment

- `SLACK_TOKEN` (default)
- `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN` (optional)
- `SLACK_LIST_SCHEMA_PATH` (optional default schema file)

## Global Options

- `--token <token>` override token
- `--as-user` use `SLACK_USER_TOKEN`
- `--schema <path>` schema JSON file
- `--refresh-schema` bypass cached schema and refresh from Slack
- `--verbose` include Slack error payloads

## Required OAuth Scopes

- `lists:read`
- `lists:write`
- `chat:write`
- `users:read`
- `channels:read`
- `files:write`

## Notes

- Slack does **not** expose a list discovery API as of January 2026. `slack-lists lists` will return an informative error unless Slack adds this method.
- Items create/update require `column_id` values. Provide a schema file via `--schema` or `SLACK_LIST_SCHEMA_PATH`.
- The CLI caches schemas per list ID at `~/.config/slack-lists-cli/schemas/<list-id>.json` (or `$XDG_CONFIG_HOME`).
- `lists info` will try `slackLists.info`; if unavailable, it infers schema from existing items (limited; no select options).

## Help (LLM-friendly)

```
slack-lists help
```

This returns JSON describing all commands, options, and environment variables for agentic coding.

## Usage

### Auth

```
slack-lists auth status
```

### Lists

```
slack-lists lists
slack-lists lists info <list-id>
slack-lists lists export <list-id> --out ./export.bin
```

### Items

```
slack-lists items list <list-id>
slack-lists items get <list-id> <item-id>
slack-lists items create <list-id> --name "Task" --priority high
slack-lists items update <list-id> <item-id> --status completed
slack-lists items update <list-id> <item-id> --field "ColumnKey=value"
```

### Comments & Messaging

```
slack-lists comment <list-id> <item-id> "Comment text" --message-url <url>
slack-lists ask <channel> "Question text?" --user @someone
slack-lists post <channel> "Message text"
```

### Evidence

```
slack-lists evidence upload <list-id> <item-id> ./file.png
slack-lists evidence upload <list-id> <item-id> ./file.png --column Evidence --column-type attachment
slack-lists evidence link <list-id> <item-id> https://example.com
slack-lists evidence list <list-id> <item-id>
```

## Schema File Format

The schema file should contain a `schema` or `columns` array (e.g. from Slack list metadata) with `id`, `key`, `name`, `type`, and `options.choices` for selects. Example:

```json
{
  "list_id": "F123",
  "schema": [
    {
      "id": "ColumnId123",
      "key": "priority",
      "name": "Priority",
      "type": "select",
      "options": {
        "choices": [
          { "value": "high", "label": "High" },
          { "value": "medium", "label": "Medium" }
        ]
      }
    }
  ]
}
```

## Output Format

All commands output JSON to stdout. Errors output JSON to stderr with exit code 1.

**Success**
```json
{
  "ok": true,
  "data": { "...": "..." }
}
```

**Error**
```json
{
  "ok": false,
  "error": "invalid_list_id",
  "details": { "list_id": "L123" }
}
```

## Agent Snippet (AGENTS.md / CLAUDE.md)

```md
## Slack Lists CLI (agentic coding)

You can use the `slack-lists` CLI for agentic coding workflows on Slack Lists. It outputs JSON for machine parsing.

### How to discover capabilities
- Run `slack-lists help` for a JSON manifest of commands, flags, and env vars.

### Required env
- `SLACK_TOKEN` (or `SLACK_BOT_TOKEN` / `SLACK_USER_TOKEN` with `--as-user`)

### Schema handling
- The CLI caches schemas per list ID at `~/.config/slack-lists-cli/schemas/<list-id>.json` (or `$XDG_CONFIG_HOME`).
- Use `--refresh-schema` if columns/options change.

### Common commands
- `slack-lists auth status`
- `slack-lists lists info <list-id>`
- `slack-lists items list <list-id>`
- `slack-lists items create <list-id> --name "Task" --priority high`
- `slack-lists items update <list-id> <item-id> --status completed`
- `slack-lists evidence upload <list-id> <item-id> ./file.png`
```

## Scripts

- `npm run build`
- `npm run dev`
- `npm run typecheck`
