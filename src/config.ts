import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "keel.json";
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const REPO_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?$/;
export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const AUTH_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

export interface AppConfig {
  name: string;
  branch: string;
  port: number;
  target: "local" | "aws";
  env: Record<string, string>;
  healthPath: string;
  repo?: string;
  dir?: string;
  db?: string;
  /** Absolute in-container path to a CA bundle (e.g. the AWS RDS bundle) the app image ships.
   *  When set, the injected DATABASE_URL uses sslmode=verify-full&sslrootcert=<path> instead
   *  of the default sslmode=no-verify. */
  dbSslRootCert?: string;
  auth?: string;
  project?: string;
}

export function validateAppConfig(c: unknown): string[] {
  const cfg = c as Partial<AppConfig>;
  const errs: string[] = [];
  if (!NAME_RE.test(cfg?.name ?? "")) errs.push("name must be lowercase letters/digits/dashes, 2-32 chars");
  if (!Number.isInteger(cfg?.port) || cfg.port! < 1 || cfg.port! > 65535) errs.push("port must be an integer 1-65535");
  if (cfg?.target !== "local" && cfg?.target !== "aws") errs.push('target must be "local" or "aws"');
  if (cfg?.target === "aws" && !REPO_RE.test(cfg?.repo ?? "")) errs.push("repo must be an https://github.com/... URL for the aws target");
  if (cfg?.branch !== undefined && typeof cfg.branch !== "string") errs.push("branch must be a string");
  if (
    cfg?.env !== undefined &&
    (typeof cfg.env !== "object" || cfg.env === null || Array.isArray(cfg.env) ||
      Object.values(cfg.env).some((v) => typeof v !== "string"))
  ) errs.push("env must be an object of string values");
  if (
    cfg?.healthPath !== undefined &&
    (typeof cfg.healthPath !== "string" || !cfg.healthPath.startsWith("/"))
  ) errs.push('healthPath must be a string starting with "/"');
  if (
    cfg?.dir !== undefined &&
    (typeof cfg.dir !== "string" || cfg.dir.startsWith("/") || cfg.dir.includes(".."))
  ) errs.push("dir must be a relative path inside the repo");
  if (cfg?.db !== undefined && (typeof cfg.db !== "string" || !DB_NAME_RE.test(cfg.db))) errs.push("db must be a lowercase postgres-safe name (letters, digits, underscores)");
  if (
    cfg?.dbSslRootCert !== undefined &&
    (typeof cfg.dbSslRootCert !== "string" || !cfg.dbSslRootCert.startsWith("/") || /[?&#\s]/.test(cfg.dbSslRootCert))
  ) errs.push("dbSslRootCert must be an absolute in-container file path (no spaces or URL metacharacters)");
  if (cfg?.project !== undefined && typeof cfg.project !== "string") errs.push("project must be a string");
  if (cfg?.auth !== undefined && (typeof cfg.auth !== "string" || !AUTH_NAME_RE.test(cfg.auth)))
    errs.push("auth must be a lowercase name (letters, digits, dashes), 2-32 chars");
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
