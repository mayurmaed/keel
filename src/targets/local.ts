import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";

export type Exec = (cmd: string, args: string[]) => Promise<string>;

function run(cmd: string, args: string[], stream: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (stream) process.stdout.write(d);
    });
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (stream) process.stderr.write(d);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`${cmd} ${args[0]} exited ${code}${err ? `: ${err.trim().slice(-2000)}` : ""}`)),
    );
  });
}

// streams stdout live (docker build progress) and returns the captured text
export const shellExec: Exec = (cmd, args) => run(cmd, args, true);
// captures stdout only — for commands whose output the caller reformats/prints itself
export const captureExec: Exec = (cmd, args) => run(cmd, args, false);

export const containerName = (app: string) => `bareboat-${app}`;

export async function deployLocal(cfg: AppConfig, dir: string, exec: Exec = shellExec): Promise<string> {
  await exec("docker", ["build", "-t", `bareboat/${cfg.name}`, dir]);
  // ponytail: rm -f fails on first deploy (no container yet) — that's fine
  await exec("docker", ["rm", "-f", containerName(cfg.name)]).catch(() => {});
  const envArgs = Object.entries(cfg.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await exec("docker", [
    "run", "-d", "--name", containerName(cfg.name), "--label", "bareboat=1",
    "--restart", "unless-stopped", "-p", `${cfg.port}:${cfg.port}`,
    ...envArgs, `bareboat/${cfg.name}`,
  ]);
  return `http://localhost:${cfg.port}`;
}

export async function listLocal(exec: Exec = captureExec): Promise<string[]> {
  const out = await exec("docker", [
    "ps", "--filter", "label=bareboat=1",
    "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}",
  ]);
  return out ? out.split("\n") : [];
}

export async function destroyLocal(name: string, exec: Exec = captureExec): Promise<void> {
  await exec("docker", ["rm", "-f", containerName(name)]);
}

export function logsLocal(name: string, follow: boolean): void {
  spawn("docker", ["logs", ...(follow ? ["-f"] : []), containerName(name)], { stdio: "inherit" });
}
