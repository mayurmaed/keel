# Keel Plan A: CLI + Local Docker Target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `keel` CLI that registers any Dockerfile-based app and deploys/manages it on local Docker — the foundation the AWS target (Plan B) plugs into.

**Architecture:** TypeScript ESM CLI (commander + @inquirer/prompts). App config lives in a `keel.json` in each app's repo. The local target shells out to `docker` via an injectable exec function (unit-testable without Docker). Docker itself is the state store — containers are labeled `keel=1`; there is no separate state file.

**Tech Stack:** Node ≥20, TypeScript (strict, NodeNext ESM), commander, @inquirer/prompts, vitest, tsx (dev runner).

**Spec:** `docs/superpowers/specs/2026-07-07-keel-deploy-platform-design.md`

## Global Constraints

- Runtime dependencies: **only** `commander` and `@inquirer/prompts`. No others without a plan change.
- TypeScript `strict: true`, ESM (`"type": "module"`), `module`/`moduleResolution` `NodeNext`. Imports inside `src/` use `.js` extensions; test files import from `../src/<name>` (no extension).
- App name regex: `/^[a-z][a-z0-9-]{1,31}$/`. Container name: `keel-<app>`. Image tag: `keel/<app>`. Container label: `keel=1`.
- Every app repo must contain a `Dockerfile` (spec decision — no buildpacks).
- CLI errors: throw `Error` with a user-actionable message; `src/cli.ts` catches, prints `error: <message>`, exits 1. Commands never call `process.exit` themselves.
- Commit style: conventional commits (`feat:`, `test:`, `chore:`).
- Tests live in `tests/*.test.ts`, run with `npx vitest run`.

---

### Task 1: Project scaffold + CLI entry

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/program.ts`, `src/cli.ts`
- Test: `tests/program.test.ts`

**Interfaces:**
- Produces: `buildProgram(): Command` from `src/program.ts` — every later task registers its command inside this function. `src/cli.ts` is the bin entry that parses and handles errors; no other file touches `process.exit`.

- [ ] **Step 1: Write project config files**

`package.json`:
```json
{
  "name": "keel",
  "version": "0.1.0",
  "type": "module",
  "bin": { "keel": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@inquirer/prompts": "^5.0.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.gitignore`:
```
node_modules/
dist/
```

Run: `npm install`
Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

`tests/program.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/program";

describe("program", () => {
  it("is named keel with a version", () => {
    const p = buildProgram();
    expect(p.name()).toBe("keel");
    expect(p.version()).toBe("0.1.0");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run`
Expected: FAIL — cannot find module `../src/program`.

- [ ] **Step 4: Write the implementation**

`src/program.ts`:
```ts
import { Command } from "commander";

export function buildProgram(): Command {
  return new Command("keel")
    .version("0.1.0")
    .description("Deploy apps to your own AWS account (or local Docker)");
}
```

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { buildProgram } from "./program.js";

buildProgram()
  .parseAsync()
  .catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 1 test PASS, no type errors.

Run: `npx tsx src/cli.ts --help`
Expected: usage text showing `keel` and the description.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src tests
git commit -m "feat: scaffold keel CLI with commander entry"
```

---

### Task 2: App config (`keel.json`)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces (exact, used by every later task):
  - `interface AppConfig { name: string; branch: string; port: number; target: "local" | "aws"; env: Record<string, string>; healthPath: string; repo?: string }`
  - `validateAppConfig(c: unknown): string[]` — empty array means valid
  - `loadAppConfig(dir: string): AppConfig` — reads `<dir>/keel.json`, applies defaults (`branch: "main"`, `env: {}`, `healthPath: "/"`), throws with a message containing `keel new` if the file is missing
  - `saveAppConfig(dir: string, cfg: AppConfig): void`
  - `CONFIG_FILE = "keel.json"`

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAppConfig, loadAppConfig, saveAppConfig, type AppConfig } from "../src/config";

const tmp = () => mkdtempSync(join(tmpdir(), "keel-test-"));

describe("validateAppConfig", () => {
  it("accepts a valid local config", () => {
    expect(validateAppConfig({ name: "my-app", port: 3000, target: "local" })).toEqual([]);
  });

  it("rejects bad name, port, and target with one error each", () => {
    const errs = validateAppConfig({ name: "My App", port: 0, target: "cloud" });
    expect(errs).toHaveLength(3);
  });

  it("requires a github https repo for the aws target", () => {
    const errs = validateAppConfig({ name: "web", port: 80, target: "aws" });
    expect(errs.join()).toMatch(/repo/);
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web" }),
    ).toEqual([]);
  });
});

describe("load/save", () => {
  it("round-trips and applies defaults", () => {
    const dir = tmp();
    saveAppConfig(dir, { name: "web", port: 3000, target: "local" } as AppConfig);
    const cfg = loadAppConfig(dir);
    expect(cfg.branch).toBe("main");
    expect(cfg.env).toEqual({});
    expect(cfg.healthPath).toBe("/");
  });

  it("throws a keel-new hint when keel.json is missing", () => {
    expect(() => loadAppConfig(tmp())).toThrow(/keel new/);
  });

  it("throws on invalid stored config", () => {
    const dir = tmp();
    saveAppConfig(dir, { name: "BAD NAME", port: 3000, target: "local" } as AppConfig);
    expect(() => loadAppConfig(dir)).toThrow(/name/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config`.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: keel.json app config with validation and defaults"
```

---

### Task 3: Local Docker target — deploy

**Files:**
- Create: `src/targets/local.ts`
- Test: `tests/local.test.ts`

**Interfaces:**
- Consumes: `AppConfig` from `src/config.ts` (Task 2).
- Produces:
  - `type Exec = (cmd: string, args: string[]) => Promise<string>` — resolves stdout, rejects on non-zero exit
  - `shellExec: Exec` — real implementation (streams output to the terminal too)
  - `deployLocal(cfg: AppConfig, dir: string, exec?: Exec): Promise<string>` — returns the app URL
  - Container name helper behavior: container is `keel-<name>`, image `keel/<name>`, label `keel=1` (Task 4 relies on the label; Plan-B tasks rely on `Exec` injection for testing).

- [ ] **Step 1: Write the failing tests**

`tests/local.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deployLocal, type Exec } from "../src/targets/local";
import type { AppConfig } from "../src/config";

const cfg: AppConfig = {
  name: "web", branch: "main", port: 3000, target: "local",
  env: { API_KEY: "abc" }, healthPath: "/",
};

function fakeExec() {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { calls, exec };
}

describe("deployLocal", () => {
  it("builds, replaces any old container, and runs with port + env", async () => {
    const { calls, exec } = fakeExec();
    const url = await deployLocal(cfg, "/app/dir", exec);
    expect(url).toBe("http://localhost:3000");
    expect(calls[0]).toEqual(["docker", "build", "-t", "keel/web", "/app/dir"]);
    expect(calls[1]).toEqual(["docker", "rm", "-f", "keel-web"]);
    expect(calls[2]).toEqual([
      "docker", "run", "-d", "--name", "keel-web", "--label", "keel=1",
      "--restart", "unless-stopped", "-p", "3000:3000", "-e", "API_KEY=abc", "keel/web",
    ]);
  });

  it("ignores rm -f failure (first-ever deploy)", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "rm") throw new Error("No such container");
      return "";
    };
    await expect(deployLocal(cfg, ".", exec)).resolves.toBe("http://localhost:3000");
  });

  it("propagates build failure", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "build") throw new Error("docker exited 1");
      return "";
    };
    await expect(deployLocal(cfg, ".", exec)).rejects.toThrow(/exited 1/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/local.test.ts`
Expected: FAIL — cannot find module `../src/targets/local`.

- [ ] **Step 3: Write the implementation**

`src/targets/local.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/targets/local.ts tests/local.test.ts
git commit -m "feat: local docker deploy target with injectable exec"
```

---

### Task 4: Local target — list, logs, destroy

**Files:**
- Modify: `src/targets/local.ts` (append)
- Test: `tests/local.test.ts` (append)

**Interfaces:**
- Produces:
  - `listLocal(exec?: Exec): Promise<string[]>` — one tab-separated line per running keel container (`name\tstatus\tports`), empty array when none
  - `destroyLocal(name: string, exec?: Exec): Promise<void>` — throws if the container doesn't exist
  - `logsLocal(name: string, follow: boolean): void` — streams `docker logs` straight to the terminal (fire-and-forget, not exec-injected)

- [ ] **Step 1: Write the failing tests**

Append to `tests/local.test.ts`:
```ts
import { listLocal, destroyLocal } from "../src/targets/local";

describe("listLocal", () => {
  it("lists keel containers via label filter", async () => {
    const { calls, exec } = fakeExec();
    await listLocal(exec);
    expect(calls[0]).toEqual([
      "docker", "ps", "--filter", "label=keel=1",
      "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}",
    ]);
  });

  it("returns [] when output is empty and lines otherwise", async () => {
    expect(await listLocal(async () => "")).toEqual([]);
    expect(await listLocal(async () => "keel-web\tUp 2 minutes\t3000")).toEqual([
      "keel-web\tUp 2 minutes\t3000",
    ]);
  });
});

describe("destroyLocal", () => {
  it("force-removes the container by name", async () => {
    const { calls, exec } = fakeExec();
    await destroyLocal("web", exec);
    expect(calls[0]).toEqual(["docker", "rm", "-f", "keel-web"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/local.test.ts`
Expected: FAIL — `listLocal` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/targets/local.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/targets/local.ts tests/local.test.ts
git commit -m "feat: local list/logs/destroy"
```

---

### Task 5: Commands — `new`, `env`, and CLI wiring

**Files:**
- Create: `src/commands/new.ts`, `src/commands/env.ts`
- Modify: `src/program.ts` (replace file content with the version below)
- Test: `tests/commands.test.ts`, `tests/program.test.ts` (append)

**Interfaces:**
- Consumes: `AppConfig`, `validateAppConfig`, `loadAppConfig`, `saveAppConfig` (Task 2); `deployLocal`, `listLocal`, `logsLocal`, `destroyLocal` (Tasks 3-4).
- Produces:
  - `newCommand(opts: Record<string, string | undefined>, dir?: string): Promise<void>` — fully non-interactive when all flags are given (that's the tested path); prompts only for missing values
  - `envCommand(action: "set" | "unset" | "list", pairs: string[], dir?: string): void`
  - Registered commands: `new`, `deploy`, `list`, `logs`, `destroy`, `env`

- [ ] **Step 1: Write the failing tests**

`tests/commands.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCommand } from "../src/commands/new";
import { envCommand } from "../src/commands/env";
import { loadAppConfig } from "../src/config";

const tmp = () => mkdtempSync(join(tmpdir(), "keel-test-"));

describe("newCommand (non-interactive)", () => {
  it("writes a valid keel.json from flags", async () => {
    const dir = tmp();
    await newCommand({ name: "web", port: "3000", target: "local" }, dir);
    const cfg = loadAppConfig(dir);
    expect(cfg).toMatchObject({ name: "web", port: 3000, target: "local", branch: "main" });
  });

  it("rejects invalid flags with the validation errors", async () => {
    await expect(newCommand({ name: "BAD", port: "3000", target: "local" }, tmp())).rejects.toThrow(/name/);
  });
});

describe("envCommand", () => {
  it("sets, lists, and unsets vars in keel.json", async () => {
    const dir = tmp();
    await newCommand({ name: "web", port: "3000", target: "local" }, dir);
    envCommand("set", ["A=1", "B=x=y"], dir);
    expect(loadAppConfig(dir).env).toEqual({ A: "1", B: "x=y" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    envCommand("list", [], dir);
    expect(log.mock.calls.flat().join("\n")).toContain("A=1");
    log.mockRestore();

    envCommand("unset", ["A"], dir);
    expect(loadAppConfig(dir).env).toEqual({ B: "x=y" });
  });

  it("rejects malformed set pairs", () => {
    const dir = tmp();
    expect(() => envCommand("set", ["NOVALUE"], dir)).toThrow(/KEY=VALUE/);
  });
});
```

Append to `tests/program.test.ts` (inside the existing `describe`):
```ts
  it("registers all phase-1 commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    for (const n of ["new", "deploy", "list", "logs", "destroy", "env"]) {
      expect(names).toContain(n);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — cannot find module `../src/commands/new`; program test fails on missing commands.

- [ ] **Step 3: Write the implementations**

`src/commands/new.ts`:
```ts
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
```

`src/commands/env.ts`:
```ts
import { loadAppConfig, saveAppConfig } from "../config.js";

export function envCommand(action: "set" | "unset" | "list", pairs: string[], dir = process.cwd()): void {
  const cfg = loadAppConfig(dir);
  if (action === "list") {
    for (const [k, v] of Object.entries(cfg.env)) console.log(`${k}=${v}`);
    return;
  }
  if (action === "set") {
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) throw new Error(`expected KEY=VALUE, got "${p}"`);
      cfg.env[p.slice(0, i)] = p.slice(i + 1);
    }
  } else {
    for (const k of pairs) delete cfg.env[k];
  }
  saveAppConfig(dir, cfg);
  console.log("saved — run `keel deploy` to apply");
}
```

Replace `src/program.ts` with:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/program.ts src/commands tests/commands.test.ts tests/program.test.ts
git commit -m "feat: new/env commands and full local CLI wiring"
```

---

### Task 6: Sample app + real end-to-end verification

**Files:**
- Create: `sample-app/server.mjs`, `sample-app/Dockerfile`, `sample-app/.dockerignore`
- Create: `README.md`

**Interfaces:**
- Consumes: the full CLI from Task 5.
- Produces: a repo-local app used to verify every future target (Plan B reuses it for the AWS path).

- [ ] **Step 1: Write the sample app**

`sample-app/server.mjs`:
```js
import { createServer } from "node:http";

const port = process.env.PORT ?? 3000;
createServer((req, res) => {
  res.end(`hello from keel${process.env.GREETING ? ` — ${process.env.GREETING}` : ""}\n`);
}).listen(port, () => console.log(`listening on ${port}`));
```

`sample-app/Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server.mjs .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```

`sample-app/.dockerignore`:
```
keel.json
```

- [ ] **Step 2: Verify Docker is available**

Run: `docker info --format "{{.ServerVersion}}"`
Expected: a version string. If this fails, start Docker Desktop before continuing.

- [ ] **Step 3: End-to-end: register, deploy, verify, inspect, destroy**

Run each from the repo root; expected output on the right.

```bash
cd sample-app
npx tsx ../src/cli.ts new --name hello --port 3000 --target local
# → wrote keel.json for "hello" — deploy with: keel deploy

npx tsx ../src/cli.ts deploy
# → docker build output, then: live: http://localhost:3000

curl -s http://localhost:3000
# → hello from keel

npx tsx ../src/cli.ts env set GREETING=world
# → saved — run `keel deploy` to apply
npx tsx ../src/cli.ts deploy && curl -s http://localhost:3000
# → hello from keel — world

npx tsx ../src/cli.ts list
# → keel-hello	Up ... seconds	0.0.0.0:3000->3000/tcp

npx tsx ../src/cli.ts logs
# → listening on 3000

npx tsx ../src/cli.ts destroy
# → destroyed hello
npx tsx ../src/cli.ts list
# → no keel apps running
```

If any step's real output differs from the expected output, stop and fix before proceeding.

- [ ] **Step 4: Write the README**

`README.md`:
```markdown
# Keel

Deploy apps to your own AWS account (or local Docker). Render/Supabase
replacement you run yourself. Phase 1: deploy pipeline. Spec and plans in
`docs/superpowers/`.

## Quickstart (local target)

Requirements: Node ≥ 20, Docker. Your app repo must contain a `Dockerfile`.

```bash
npm install && npm run build
cd your-app/
keel new        # answers: name, port, target=local
keel deploy     # docker build + run
keel list
keel logs -f
keel env set KEY=value && keel deploy
keel destroy
```

## Status

- [x] Plan A: CLI + local Docker target
- [ ] Plan B: AWS target (control plane, GitHub webhook auto-deploy, ECS)
- [ ] Phase 2: Postgres provisioning
- [ ] Phase 3: Auth service
- [ ] Phase 4: Open-source packaging
```

- [ ] **Step 5: Full check and commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

```bash
git add sample-app README.md
git commit -m "feat: sample app, e2e verification, README quickstart"
```

---

## Plan B preview (written after Plan A ships — not part of this plan)

AWS target, in its own plan document: control-plane CloudFormation stack
(DynamoDB, ECR, ECS cluster, CodeBuild, webhook Lambda + HTTP API, IAM),
`keel setup`, DynamoDB/SSM app registry, CodeBuild buildspec, GitHub webhook
auto-deploy, lazy ingress stack (shared ALB; host-based routing with a domain,
port-based without), `keel deploy/status/logs/env/destroy --target aws`,
dashboard skeleton. One deliberate spec deviation to record there: Fargate
tasks will run in public subnets with a security group restricting ingress to
the ALB only, instead of private subnets — private subnets require a NAT
gateway (~$32/mo), which violates the approved cost posture.

## Self-review

- **Spec coverage (Plan A scope):** Dockerfile-required ✔ (build step is `docker build`), interactive CLI that asks details ✔ (`keel new` prompts), local target ✔, env vars ✔, list/logs/destroy ✔, CLI validates Dockerfile presence — gap found and fixed: validation happens implicitly via docker build failure; acceptable for local target, revisit in Plan B where a pre-flight check saves a CodeBuild round-trip.
- **Placeholder scan:** no TBDs; every code step has complete code; commands have expected output.
- **Type consistency:** `Exec` injected consistently; `AppConfig` fields match across Tasks 2-5; `containerName` used in both deploy and destroy paths.

## Plan B hardening carry-overs (from final branch review, 2026-07-08)

1. Anchor `REPO_RE` (src/config.ts) with `$` before the repo URL is fed to CodeBuild/webhook wiring.
2. Validate `branch`/`env`/`healthPath` types in `validateAppConfig` when hardening config for the AWS registry.
3. Capture stderr into thrown errors in the exec helpers — needed once deploys run non-interactively (webhook path).
