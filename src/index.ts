#!/usr/bin/env node

import { Command, CommanderError } from "commander";

import { registerAuthCommands } from "./commands/auth";
import { registerAccessCommands } from "./commands/access";
import { registerCommentCommands } from "./commands/comments";
import { registerFilesCommands } from "./commands/files";
import { registerHelpCommand } from "./commands/help";
import { registerItemsCommands } from "./commands/items";
import { registerListsCommands } from "./commands/lists";
import { registerSchemaCommand } from "./commands/schema";
import { registerThreadsCommands } from "./commands/threads";
import { loadEnvFiles } from "./lib/env";
import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from "./lib/metadata";
import { formatError, outputError } from "./utils/output";

loadEnvFiles();

const program = new Command();

program
  .name(CLI_NAME)
  .description(CLI_DESCRIPTION)
  .version(CLI_VERSION)
  .option("--token <token>", "Override token (otherwise uses env)")
  .option("--as-user", "Force SLACK_USER_TOKEN")
  .option("--schema <path>", "Path to a list schema JSON file")
  .option("--refresh-schema", "Bypass cached schema and refresh from Slack", false)
  .option("--verbose", "Enable verbose error output", false);

program.exitOverride();

registerAuthCommands(program);
registerAccessCommands(program);
registerListsCommands(program);
registerSchemaCommand(program);
registerItemsCommands(program);
registerCommentCommands(program);
registerFilesCommands(program);
registerThreadsCommands(program);
registerHelpCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
    return;
  }

  outputError("cli_error", formatError(error));
});
