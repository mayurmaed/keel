import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { loadAppConfig } from "./config.js";
import { deployLocal, listLocal, logsLocal, destroyLocal } from "./targets/local.js";
import { registerAwsApp, deployAws, statusAws, envAws, logsAws, destroyAws } from "./targets/aws.js";
import { newCommand } from "./commands/new.js";
import { envCommand } from "./commands/env.js";
import { setupCommand } from "./commands/setup.js";
import { dbCreate, dbList, dbUrl, dbAllowIp, dbDestroy } from "./commands/db.js";

async function printLocalApps(): Promise<void> {
  const lines = await listLocal();
  console.log(lines.length ? lines.join("\n") : "no keel apps running");
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
    .action(async (opts) => {
      await newCommand(opts);
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") await registerAwsApp(cfg);
    });

  program
    .command("deploy")
    .description("build and run the app in the current directory")
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        await deployAws(cfg);
        return;
      }
      const url = await deployLocal(cfg, process.cwd());
      console.log(`live: ${url}`);
    });

  program
    .command("list")
    .description("show running keel apps")
    .action(printLocalApps);

  program
    .command("logs")
    .description("show app logs")
    .option("-f, --follow", "stream logs")
    .action(async (opts) => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        await logsAws(cfg, {}, { follow: Boolean(opts.follow) });
        return;
      }
      logsLocal(cfg.name, Boolean(opts.follow));
    });

  program
    .command("destroy")
    .description("stop and remove the app's container (or the AWS app + its records)")
    .option("--yes", "skip confirmation")
    .action(async (opts) => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        if (!opts.yes) {
          const ok = await confirm({
            message: `Destroy AWS app "${cfg.name}" (service, routing, records, secrets)? This cannot be undone.`,
            default: false,
          });
          if (!ok) {
            console.log("aborted");
            return;
          }
        }
        await destroyAws(cfg);
        return;
      }
      await destroyLocal(cfg.name);
      console.log(`destroyed ${cfg.name}`);
    });

  program
    .command("env")
    .description("manage app env vars: keel env set K=V ... | unset K ... | list")
    .argument("<action>", "set | unset | list")
    .argument("[pairs...]")
    .action(async (action: string, pairs: string[]) => {
      if (action !== "set" && action !== "unset" && action !== "list") {
        throw new Error(`unknown env action "${action}" — use set, unset, or list`);
      }
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") await envAws(action, pairs, cfg);
      else envCommand(action, pairs);
    });

  program
    .command("status")
    .description("recent deploys (aws) or running container (local)")
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        await statusAws(cfg);
        return;
      }
      await printLocalApps();
    });

  program
    .command("setup")
    .description("one-time: deploy the keel control plane into your AWS account")
    .option("--region <region>")
    .option("--domain <domain>", "base domain for app URLs (stored now, wired in Plan B2)")
    .option("--ingress <mode>", '"port" or "domain"')
    .option("--github-token <token>", "token for cloning private repos (stored in SSM)")
    .option("--profile <profile>", "AWS CLI profile to use (remembered for all keel commands)")
    .option("--yes", "non-interactive: accept defaults")
    .action((opts) => setupCommand(opts));

  const db = program.command("db").description("managed postgres (rds) databases");
  db.command("create <name>")
    .option("--isolation <mode>", '"shared" (default) or "dedicated"', "shared")
    .option("--project <project>")
    .action((name: string, opts: { isolation: string; project?: string }) => dbCreate(name, opts));
  db.command("list").action(() => dbList());
  db.command("url <name>").action((name: string) => dbUrl(name));
  db.command("allow-ip [ip]").option("--db <name>")
    .action((ip: string | undefined, opts: { db?: string }) => dbAllowIp({ ip, db: opts.db }));
  db.command("destroy <name>").option("--yes", "skip confirmation")
    .action(async (name: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm({ message: `Destroy database "${name}"? Data is deleted. This cannot be undone.`, default: false });
        if (!ok) { console.log("aborted"); return; }
      }
      await dbDestroy(name);
    });

  return program;
}
