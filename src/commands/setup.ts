import { Command } from "commander";

import { getProjectConfig, getProjectConfigPath } from "../lib/config";
import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from "../lib/metadata";
import { outputJson } from "../utils/output";

type SetupStep = {
  id: string;
  title: string;
  status: "complete" | "needed" | "optional";
  details?: string;
  commands?: string[];
  requires?: Array<{ key: string; description: string; current?: boolean }>;
};

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Output setup steps for agents (JSON)")
    .action(() => {
      const projectConfig = getProjectConfig();
      const projectConfigPath = getProjectConfigPath();

      const slackToken =
        process.env.SLACK_TOKEN ?? process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_USER_TOKEN;
      const linearApiKey = process.env.LINEAR_API_KEY ?? projectConfig?.linear?.api_key;
      const teamId = process.env.LINEAR_TEAM_ID ?? projectConfig?.linear?.team_id;
      const cycleId = process.env.LINEAR_CYCLE_ID ?? projectConfig?.linear?.cycle_id;
      const defaultChannel =
        process.env.SLACK_LIST_DEFAULT_CHANNEL ?? projectConfig?.slack?.default_channel;

      const steps: SetupStep[] = [
        {
          id: "install",
          title: "Install CLI",
          status: "complete",
          commands: [`npm install -g ${CLI_NAME}`],
          details: "Install globally or use a local path install for development."
        },
        {
          id: "slack-app",
          title: "Create Slack app + token",
          status: slackToken ? "complete" : "needed",
          details: "Use slack-app-manifest.yaml, install the app, and copy the bot token.",
          requires: [
            {
              key: "SLACK_TOKEN",
              description: "Slack bot token (xoxb-...)",
              current: Boolean(slackToken)
            }
          ],
          commands: ["ml-agent auth status"]
        },
        {
          id: "linear-token",
          title: "Create Linear API key + team",
          status: linearApiKey && teamId ? "complete" : "needed",
          details: "Create a Linear API key and set a default team ID.",
          requires: [
            {
              key: "LINEAR_API_KEY",
              description: "Linear API key (lin_api_...)",
              current: Boolean(linearApiKey)
            },
            {
              key: "LINEAR_TEAM_ID",
              description: "Default Linear team ID",
              current: Boolean(teamId)
            }
          ],
          commands: ["ml-agent linear auth status", "ml-agent linear teams"]
        },
        {
          id: "project-config",
          title: "Create project config file",
          status: projectConfigPath ? "complete" : "needed",
          details: "Create .ml-agent.config.json in the repo root to store defaults.",
          commands: ["cat .ml-agent.config.json"],
          requires: [
            {
              key: ".ml-agent.config.json",
              description: "Project config with linear.api_key + linear.team_id + slack.default_channel",
              current: Boolean(projectConfigPath)
            }
          ]
        },
        {
          id: "slack-channel",
          title: "Invite bot to Slack channel",
          status: defaultChannel ? "complete" : "needed",
          details: "Invite the bot to the channel used for agent updates.",
          requires: [
            {
              key: "SLACK_LIST_DEFAULT_CHANNEL",
              description: "Default channel ID or #name",
              current: Boolean(defaultChannel)
            }
          ],
          commands: ["/invite @ml-agent"]
        },
        {
          id: "linear-verify",
          title: "Verify Linear issue access",
          status: linearApiKey && teamId ? "complete" : "needed",
          commands: ["ml-agent issues list", "ml-agent issues create --title \"Test\" --team <team-id>"]
        },
        {
          id: "screenshots",
          title: "Install Playwright (optional)",
          status: "optional",
          details: "Only required for screenshot capture commands.",
          commands: ["npx playwright install chromium"]
        }
      ];

      outputJson({
        ok: true,
        name: CLI_NAME,
        version: CLI_VERSION,
        description: CLI_DESCRIPTION,
        project_config_path: projectConfigPath ?? null,
        detected: {
          slack_token: Boolean(slackToken),
          linear_api_key: Boolean(linearApiKey),
          linear_team_id: Boolean(teamId),
          linear_cycle_id: Boolean(cycleId),
          default_channel: Boolean(defaultChannel)
        },
        steps
      });
    });
}
