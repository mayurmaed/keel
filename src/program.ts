import { Command } from "commander";
import { loadAppConfig } from "./config.js";
import { deployLocal, listLocal, logsLocal, destroyLocal } from "./targets/local.js";
import { newCommand } from "./commands/new.js";
import { envCommand } from "./commands/env.js";

function localOnly(target: string): void {
  if (target !== "local") {
    throw new Error('the aws target ships in Plan B — set "target": "local" in keel.json for now');
  }
}

export function buildProgram(): Command {
  const program = new Command("keel")
    .version("0.1.0")
    .description("Deploy apps to your own AWS account (or local Docker)");

  program
    .command("new")
    .description("register the app in the current directory (writes keel.json)")
    .option("--name <name>")
    .option("--port <port>")
    .option("--target <target>", '"local" or "aws"')
    .option("--repo <url>")
    .option("--branch <branch>")
    .action((opts) => newCommand(opts));

  program
    .command("deploy")
    .description("build and run the app in the current directory")
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      localOnly(cfg.target);
      const url = await deployLocal(cfg, process.cwd());
      console.log(`live: ${url}`);
    });

  program
    .command("list")
    .description("show running keel apps")
    .action(async () => {
      const lines = await listLocal();
      console.log(lines.length ? lines.join("\n") : "no keel apps running");
    });

  program
    .command("logs")
    .description("show app logs")
    .option("-f, --follow", "stream logs")
    .action((opts) => {
      const cfg = loadAppConfig(process.cwd());
      localOnly(cfg.target);
      logsLocal(cfg.name, Boolean(opts.follow));
    });

  program
    .command("destroy")
    .description("stop and remove the app's container")
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      localOnly(cfg.target);
      await destroyLocal(cfg.name);
      console.log(`destroyed ${cfg.name}`);
    });

  program
    .command("env")
    .description("manage app env vars: keel env set K=V ... | unset K ... | list")
    .argument("<action>", "set | unset | list")
    .argument("[pairs...]")
    .action((action: string, pairs: string[]) => {
      if (action !== "set" && action !== "unset" && action !== "list") {
        throw new Error(`unknown env action "${action}" — use set, unset, or list`);
      }
      envCommand(action, pairs);
    });

  return program;
}
