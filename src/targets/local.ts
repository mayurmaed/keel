import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";

export type Exec = (cmd: string, args: string[]) => Promise<string>;

export const shellExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args[0]} exited ${code}`)),
    );
  });

export const containerName = (app: string) => `keel-${app}`;

export async function deployLocal(cfg: AppConfig, dir: string, exec: Exec = shellExec): Promise<string> {
  await exec("docker", ["build", "-t", `keel/${cfg.name}`, dir]);
  // ponytail: rm -f fails on first deploy (no container yet) — that's fine
  await exec("docker", ["rm", "-f", containerName(cfg.name)]).catch(() => {});
  const envArgs = Object.entries(cfg.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await exec("docker", [
    "run", "-d", "--name", containerName(cfg.name), "--label", "keel=1",
    "--restart", "unless-stopped", "-p", `${cfg.port}:${cfg.port}`,
    ...envArgs, `keel/${cfg.name}`,
  ]);
  return `http://localhost:${cfg.port}`;
}

export async function listLocal(exec: Exec = shellExec): Promise<string[]> {
  const out = await exec("docker", [
    "ps", "--filter", "label=keel=1",
    "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}",
  ]);
  return out ? out.split("\n") : [];
}

export async function destroyLocal(name: string, exec: Exec = shellExec): Promise<void> {
  await exec("docker", ["rm", "-f", containerName(name)]);
}

export function logsLocal(name: string, follow: boolean): void {
  spawn("docker", ["logs", ...(follow ? ["-f"] : []), containerName(name)], { stdio: "inherit" });
}
