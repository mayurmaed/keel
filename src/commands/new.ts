import { input, select } from "@inquirer/prompts";
import { type AppConfig, validateAppConfig, saveAppConfig, CONFIG_FILE } from "../config.js";

export async function newCommand(
  opts: Record<string, string | undefined>,
  dir = process.cwd(),
): Promise<void> {
  const name = opts.name ?? (await input({ message: "App name (lowercase, dashes)" }));
  const port = Number(opts.port ?? (await input({ message: "Container port", default: "3000" })));
  const target =
    (opts.target as AppConfig["target"] | undefined) ??
    ((await select({
      message: "Deploy target",
      choices: [
        { name: "local (Docker on this machine)", value: "local" },
        { name: "aws (your AWS account — needs keel setup)", value: "aws" },
      ],
    })) as AppConfig["target"]);
  const repo =
    opts.repo ?? (target === "aws" ? await input({ message: "GitHub repo URL (https)" }) : undefined);

  const cfg: AppConfig = {
    name,
    port,
    target,
    branch: opts.branch ?? "main",
    env: {},
    healthPath: "/",
    ...(repo ? { repo } : {}),
  };
  const errs = validateAppConfig(cfg);
  if (errs.length) throw new Error(errs.join("; "));
  saveAppConfig(dir, cfg);
  console.log(`wrote ${CONFIG_FILE} for "${name}" — deploy with: keel deploy`);
}
