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

### Local development install (recommended)

If `npm link slack-lists-cli` hangs from another repo, use one of these instead:

Option A (single-step link):
```bash
npm link /absolute/path/to/slack-lists-cli
```

Option B (file dependency):
```bash
npm install --save-dev /absolute/path/to/slack-lists-cli
```

After linking/installing, the bin name is `slack-lists`:
```bash
slack-lists help
# or
npx slack-lists help
```

### No-install dev option

You can always run the CLI directly:
```bash
node /absolute/path/to/slack-lists-cli/dist/index.js <command>
```

## Quickstart (Testing with Slack)

1) Create a Slack app from `slack-app-manifest.yaml`, then install it to your workspace.
2) Copy the Bot User OAuth Token (`xoxb-...`) and place it in `.env.local`:
   ```
   SLACK_TOKEN=xoxb-...
   ```
3) Invite the bot to the channel where the list is shared:
   ```
   /invite @lists-cli
   ```
4) If you see `list_not_found`, explicitly grant list access to the channel:
   ```
   slack-lists access set FXXXX --channels CXXXX --level write
   ```
5) Verify the CLI:
   ```
   node dist/index.js auth status
   node dist/index.js lists info <list-id>
   node dist/index.js items list <list-id>
   ```

## Environment

- `SLACK_TOKEN` (default)
- `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN` (optional)
- `SLACK_LIST_SCHEMA_PATH` (optional default schema file)
- `SLACK_LIST_DEFAULT_CHANNEL` (optional default channel for comment threads)
- `SLACK_LIST_CONFIG_PATH` (optional path to config.json for per-list defaults)
- `SLACK_LIST_THREAD_MAP_PATH` (optional path to threads.json for item → thread mapping)
- `.env.local` or `.env` files are loaded automatically if present

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
- `users:read.email`
- `channels:read`
- `groups:read`
- `files:write`

Optional (for comment history via `comments`):
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`

Optional (for thread cleanup via `threads cleanup`):
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`

## Notes

- Slack does **not** expose a list discovery API as of January 2026. `slack-lists lists` will return an informative error unless Slack adds this method.
- Items create/update use schema to map friendly flags (`--name`, `--status`, etc). The CLI auto-caches schemas from list/item reads.
- If a list has no items (or columns never populated), Slack won’t expose those columns. Provide `--schema` or use `--field` with `column_id` in that case.
- The CLI caches schemas per list ID at `~/.config/slack-lists-cli/schemas/<list-id>.json` (or `$XDG_CONFIG_HOME`).
- `lists info` will try `slackLists.info`; if unavailable, it infers schema from existing items (limited; no select options or empty columns).
- Schema cache is updated in the background on list/item reads (best-effort) to keep columns in sync.

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
slack-lists lists id <list-url>
slack-lists lists info <list-id>
slack-lists schema <list-id>
slack-lists schema <list-id> --for-update
slack-lists lists export <list-id> --out ./export.bin
```

### Access

```
slack-lists access set <list-id> --channels C123 --level write
slack-lists access delete <list-id> --channels C123
```

### Items

```
slack-lists items list <list-id>
slack-lists items list <list-id> --compact
slack-lists items get <list-id> <item-id>
slack-lists items create <list-id> --name "Task" --priority high
slack-lists items create <list-id> --name "Task" --agent-state needs_input
slack-lists items update <list-id> <item-id> --status completed
slack-lists items update <list-id> <item-id> --agent-state ready_for_test
slack-lists items update <list-id> <item-id> --field "ColumnKey=value"
```

### Comments & Messaging

```
slack-lists comment <list-id> <item-id> "Comment text" --message-url <url>
slack-lists comments <list-id> <item-id> --compact
slack-lists threads set <list-id> <item-id> --message-url <url>
slack-lists threads get <list-id> <item-id>
slack-lists threads cleanup <list-id> <item-id> --message-url <url> --root-only
slack-lists ask <channel> "Question text?" --user @someone
slack-lists post <channel> "Message text"
```

If a list item doesn’t have a Message link yet, `SLACK_LIST_DEFAULT_CHANNEL` is used to
create a thread and attach the permalink automatically.

### Evidence

```
slack-lists evidence upload <list-id> <item-id> ./file.png
slack-lists evidence upload <list-id> <item-id> ./file.png --column Evidence --column-type attachment
slack-lists evidence link <list-id> <item-id> https://example.com
slack-lists evidence list <list-id> <item-id>
```

## Schema File Format

Provide a schema file when the CLI can’t infer one (e.g., empty lists). It should contain a `schema` or `columns` array (from Slack list metadata or exports) with `id`, `key`, `name`, `type`, and `options.choices` for selects. Example:

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

## Agent State (recommended)

For simple agent workflows, add a select field to your list:

- **Field name**: `Agent State`
- **Field key**: `agent_state`
- **Values**:
  - `needs_input`
  - `in_progress`
  - `blocked`
  - `ready_for_review`
  - `ready_for_test`

Once present, the CLI exposes:
```
slack-lists items update <list-id> <item-id> --agent-state needs_input
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
- `SLACK_LIST_DEFAULT_CHANNEL` (optional, channel ID or #name for auto-threading)
- `SLACK_LIST_CONFIG_PATH` (optional config.json for per-list defaults)
- `SLACK_LIST_THREAD_MAP_PATH` (optional threads.json for item → thread mapping)

### Schema handling
- The CLI caches schemas per list ID at `~/.config/slack-lists-cli/schemas/<list-id>.json` (or `$XDG_CONFIG_HOME`).
- Cache is updated automatically on list/item reads; for empty lists, pass `--schema`.
- Use `--refresh-schema` if columns/options change.
- Use `slack-lists schema <list-id>` for compact, token-efficient schema output.
- Use `slack-lists schema <list-id> --for-update` for update hints and examples.

### Default channel for comments
- Set `SLACK_LIST_DEFAULT_CHANNEL` (e.g. `#team-channel` or `C12345678`) so the CLI can
  auto-create a thread and store its permalink when you post the first comment on an item.

You can also set per-list defaults in `~/.config/slack-lists-cli/config.json`:
```json
{
  "default_channel": "C12345678",
  "lists": {
    "F123456789": { "channel": "C12345678" }
  }
}
```

Thread mappings are stored in `~/.config/slack-lists-cli/threads.json` and can be managed
via `slack-lists threads set/get`.

To clean up duplicate threads created by accident:
- Preferred (requires history scopes):  
  `slack-lists threads cleanup <list-id> <item-id> --message-url <url>`
- Without history scopes (root only):  
  `slack-lists threads cleanup <list-id> <item-id> --message-url <url> --root-only`

### Common commands
- `slack-lists auth status`
- `slack-lists lists info <list-id>`
- `slack-lists lists id <list-url>`
- `slack-lists schema <list-id>`
- `slack-lists schema <list-id> --for-update`
- `slack-lists items list <list-id>`
- `slack-lists items list <list-id> --compact`
- `slack-lists items create <list-id> --name "Task" --priority high`
- `slack-lists items update <list-id> <item-id> --agent-state needs_input`
- `slack-lists items update <list-id> <item-id> --status completed`
- `slack-lists comments <list-id> <item-id> --compact`
- `slack-lists evidence upload <list-id> <item-id> ./file.png`
```

## Scripts

- `npm run build`
- `npm run dev`
- `npm run typecheck`
- `npm run prepare` (auto-builds dist for linking)
