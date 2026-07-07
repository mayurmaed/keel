import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "keel.json";
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const REPO_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+/;

export interface AppConfig {
  name: string;
  branch: string;
  port: number;
  target: "local" | "aws";
  env: Record<string, string>;
  healthPath: string;
  repo?: string;
}

export function validateAppConfig(c: unknown): string[] {
  const cfg = c as Partial<AppConfig>;
  const errs: string[] = [];
  if (!NAME_RE.test(cfg?.name ?? "")) errs.push("name must be lowercase letters/digits/dashes, 2-32 chars");
  if (!Number.isInteger(cfg?.port) || cfg.port! < 1 || cfg.port! > 65535) errs.push("port must be an integer 1-65535");
  if (cfg?.target !== "local" && cfg?.target !== "aws") errs.push('target must be "local" or "aws"');
  if (cfg?.target === "aws" && !REPO_RE.test(cfg?.repo ?? "")) errs.push("repo must be an https://github.com/... URL for the aws target");
  return errs;
}

export function loadAppConfig(dir: string): AppConfig {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) throw new Error(`no ${CONFIG_FILE} in ${dir} — run \`keel new\` first`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  const errs = validateAppConfig(raw);
  if (errs.length) throw new Error(`invalid ${CONFIG_FILE}: ${errs.join("; ")}`);
  return { branch: "main", env: {}, healthPath: "/", ...raw } as AppConfig;
}

export function saveAppConfig(dir: string, cfg: AppConfig): void {
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + "\n");
}
