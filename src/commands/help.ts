import { Command } from "commander";

import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from "../lib/metadata";
import { outputJson } from "../utils/output";

export function registerHelpCommand(program: Command): void {
  program
    .command("help")
    .description("Show CLI capabilities in JSON for agentic coding")
    .action(() => {
      outputJson(getCapabilities());
    });
}

function getCapabilities() {
  return {
    name: CLI_NAME,
    version: CLI_VERSION,
    description: CLI_DESCRIPTION,
    globals: [
      { flag: "--token <token>", description: "Override token (otherwise uses env)" },
      { flag: "--as-user", description: "Use SLACK_USER_TOKEN" },
      { flag: "--schema <path>", description: "Path to a list schema JSON file" },
      { flag: "--refresh-schema", description: "Bypass cached schema and refresh from Slack" },
      { flag: "--verbose", description: "Include Slack error payloads" }
    ],
    env: [
      { name: "SLACK_TOKEN", description: "Default token" },
      { name: "SLACK_BOT_TOKEN", description: "Optional bot token" },
      { name: "SLACK_USER_TOKEN", description: "Optional user token (used with --as-user)" },
      { name: "SLACK_LIST_SCHEMA_PATH", description: "Default schema JSON path" },
      {
        name: "SLACK_LIST_DEFAULT_CHANNEL",
        description: "Fallback channel for comment threads (ID or #name)"
      },
      {
        name: "SLACK_LIST_CONFIG_PATH",
        description: "Optional path to config.json (per-list defaults)"
      }
    ],
    schema_cache: {
      path: "~/.config/slack-lists-cli/schemas/<list-id>.json",
      description:
        "Cached schema per list ID (populated from list/item reads; uses $XDG_CONFIG_HOME when set)"
    },
    commands: [
      {
        command: "auth status",
        description: "Verify token works",
        args: [],
        options: []
      },
      {
        command: "access set <list-id>",
        description: "Grant list access to channels or users",
        args: ["list-id"],
        options: ["--channels <channels>", "--users <users>", "--level <level>"]
      },
      {
        command: "access delete <list-id>",
        description: "Revoke list access from channels or users",
        args: ["list-id"],
        options: ["--channels <channels>", "--users <users>"]
      },
      {
        command: "lists",
        description: "List accessible lists (if Slack supports list discovery)",
        args: [],
        options: []
      },
      {
        command: "lists id <url>",
        description: "Extract list ID from Slack list URL",
        args: ["url"],
        options: []
      },
      {
        command: "lists info <list-id>",
        description: "Fetch list schema (falls back to inference when list metadata is unavailable)",
        args: ["list-id"],
        options: []
      },
      {
        command: "schema <list-id>",
        description: "Compact schema output for agentic updates",
        args: ["list-id"],
        options: ["--for-update"]
      },
      {
        command: "lists export <list-id>",
        description: "Export list via download job",
        args: ["list-id"],
        options: ["--format <format>", "--out <path>", "--poll-interval <ms>", "--timeout <ms>"]
      },
      {
        command: "items list <list-id>",
        description: "List items (filters require schema; cache syncs from reads)",
        args: ["list-id"],
        options: ["--status <status>", "--assignee <assignee>", "--archived", "--limit <limit>", "--compact"]
      },
      {
        command: "items get <list-id> <item-id>",
        description: "Get item details",
        args: ["list-id", "item-id"],
        options: []
      },
      {
        command: "items create <list-id>",
        description: "Create item (auto-syncs schema; empty lists still need --schema)",
        args: ["list-id"],
        options: [
          "--name <name>",
          "--assignee <assignee>",
          "--priority <priority>",
          "--status <status>",
          "--due <date>",
          "--field <key=value|json>"
        ]
      },
      {
        command: "items update <list-id> <item-id>",
        description: "Update item fields",
        args: ["list-id", "item-id"],
        options: [
          "--assignee <assignee>",
          "--priority <priority>",
          "--status <status>",
          "--due <date>",
          "--field <key=value|json>"
        ]
      },
      {
        command: "items delete <list-id> <item-id>",
        description: "Delete item",
        args: ["list-id", "item-id"],
        options: []
      },
      {
        command: "comment <list-id> <item-id> <text>",
        description: "Post comment to item thread",
        args: ["list-id", "item-id", "text"],
        options: ["--channel <channel>", "--thread-ts <ts>", "--message-url <url>"]
      },
      {
        command: "comments <list-id> <item-id>",
        description: "Fetch item comment thread (requires history scopes)",
        args: ["list-id", "item-id"],
        options: ["--channel <channel>", "--thread-ts <ts>", "--message-url <url>", "--limit <count>", "--compact"]
      },
      {
        command: "ask <channel> <text>",
        description: "Ask a question in a channel",
        args: ["channel", "text"],
        options: ["--user <user>"]
      },
      {
        command: "post <channel> <text>",
        description: "Post a message to a channel",
        args: ["channel", "text"],
        options: []
      },
      {
        command: "evidence upload <list-id> <item-id> <file-path>",
        description: "Upload file and attach to item",
        args: ["list-id", "item-id", "file-path"],
        options: ["--description <text>", "--column <column>", "--column-type <attachment|reference>", "--channel <channel>"]
      },
      {
        command: "evidence link <list-id> <item-id> <url>",
        description: "Attach a link to an item",
        args: ["list-id", "item-id", "url"],
        options: ["--description <text>", "--column <column>"]
      },
      {
        command: "evidence list <list-id> <item-id>",
        description: "List evidence fields on an item",
        args: ["list-id", "item-id"],
        options: []
      }
    ]
  };
}
