# Keel Plan B1: AWS Control Plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `keel setup` stands up a serverless control plane in the user's AWS account; `keel new/deploy` for `target: "aws"` registers apps and runs GitHub-push → webhook → CodeBuild → docker build → ECR push → ECS task-definition registration. (Live URLs/ALB land in Plan B2.)

**Architecture:** The CLI provisions one CloudFormation stack (`keel-control-plane`): DynamoDB single-table registry, one shared ECR repo, ECS cluster, CodeBuild project with an inline buildspec, and a webhook Lambda (inline ZipFile, <4KB) behind an HTTP API. All AWS modules take injectable client deps (same seam pattern as `Exec`), so tests never touch AWS.

**Tech Stack:** Plan A stack + `@aws-sdk/*` v3 clients. CloudFormation YAML in `infra/`. Webhook Lambda is plain CommonJS (`infra/webhook-handler.js`) injected into the template as a parameter.

**Spec:** `docs/superpowers/specs/2026-07-07-keel-deploy-platform-design.md`
**Recorded spec deviation (approved in Plan A review):** Fargate tasks will use public subnets + security-group isolation instead of private subnets (NAT gateway ~$32/mo violates cost posture). Applies in Plan B2.

## Global Constraints

- Runtime dependencies: `commander`, `@inquirer/prompts`, and `@aws-sdk/*` packages only.
- TypeScript `strict: true`, ESM, `NodeNext`. Imports inside `src/` use `.js` extensions; test files import from `../src/<name>` (no extension). `infra/webhook-handler.js` is deliberately CommonJS (Lambda inline ZipFile becomes `index.js`).
- CLI errors: thrown `Error` with a user-actionable message; only `src/cli.ts` catches/exits. Commands never call `process.exit`.
- All AWS access goes through injected clients (objects with `send(command)`); tests use fakes that record commands and answer by command constructor name. No test may hit the network.
- Naming: stack `keel-control-plane`, table `keel`, ECR repo `keel-apps` (image tags `<app>` and `<app>-<commit>`), CodeBuild project `keel-build`, Lambda `keel-webhook`, ECS family/service `keel-<app>`, SSM prefix `/keel/`.
- DynamoDB keys: app record `PK=APP#<name>, SK=META`; deploy record `PK=APP#<name>, SK=DEPLOY#<id>` where id = UTC `YYYYMMDDTHHMMSSZ`.
- Deploy statuses: `queued` → `building` → `live` | `failed`.
- Commit style: conventional commits. Tests in `tests/*.test.ts`, `npx vitest run`.

---

### Task 1: Hardening carry-overs + `dir` field

**Files:**
- Modify: `src/config.ts`, `src/targets/local.ts`
- Test: `tests/config.test.ts`, `tests/local.test.ts` (append)

**Interfaces:**
- Consumes: existing `AppConfig`, `validateAppConfig`, exec helpers.
- Produces: `AppConfig` gains `dir?: string` (subdirectory of the repo containing the Dockerfile — monorepo support; needed to dogfood `sample-app/` from the keel repo itself). `REPO_RE` anchored. `validateAppConfig` also validates `branch`/`env`/`healthPath`/`dir` types. Exec errors now include captured stderr.

- [ ] **Step 1: Append failing tests**

Append to `tests/config.test.ts` (inside `describe("validateAppConfig")`):
```ts
  it("rejects repo URLs with trailing garbage, accepts optional .git", () => {
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web/extra" }),
    ).toHaveLength(1);
    expect(
      validateAppConfig({ name: "web", port: 80, target: "aws", repo: "https://github.com/me/web.git" }),
    ).toEqual([]);
  });

  it("rejects wrong types for branch, env, healthPath, dir", () => {
    const errs = validateAppConfig({
      name: "web", port: 80, target: "local",
      branch: 5, env: "oops", healthPath: "nope", dir: "/abs",
    });
    expect(errs).toHaveLength(4);
  });

  it("accepts a relative dir", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", dir: "sample-app" })).toEqual([]);
  });
```

Append to `tests/local.test.ts` (inside `describe("exec implementations")`):
```ts
  it("includes captured stderr in the failure error", async () => {
    const spyOut = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        captureExec("node", ["-e", "process.stderr.write('boom'); process.exit(3)"]),
      ).rejects.toThrow(/exited 3.*boom/s);
    } finally {
      spyOut.mockRestore();
      spyErr.mockRestore();
    }
  });
```

Run: `npx vitest run` — Expected: FAIL (new assertions).

- [ ] **Step 2: Implement**

In `src/config.ts`, replace `REPO_RE` and the interface/validator:
```ts
const REPO_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?$/;
```
Add to `AppConfig`:
```ts
  dir?: string;
```
Append inside `validateAppConfig` (before `return errs;`):
```ts
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
```

In `src/targets/local.ts`, replace the private `exec` runner so stderr is captured and appended to failures (streaming mode also mirrors stderr live):
```ts
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
export const shellExec: Exec = (cmd, args) => run(cmd, args, true);
export const captureExec: Exec = (cmd, args) => run(cmd, args, false);
```
(Keep the existing exported names/signatures; only the internals change. Keep the existing ponytail comment on the rm -f swallow.)

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add src/config.ts src/targets/local.ts tests/config.test.ts tests/local.test.ts
git commit -m "feat: harden config validation, capture stderr in exec errors, add dir field"
```

---

### Task 2: AWS SDK deps, global config, client factory

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/aws/globalconfig.ts`, `src/aws/clients.ts`
- Test: `tests/globalconfig.test.ts`

**Interfaces:**
- Produces:
  - `interface GlobalConfig { region: string; baseDomain?: string; githubTokenStored?: boolean; controlPlane?: ControlPlane }` with `interface ControlPlane { stackName: string; tableName: string; clusterName: string; ecrRepoUri: string; buildProject: string; webhookBase: string; taskExecRoleArn: string; logGroup: string; vpcId: string; subnetIds: string[] }`
  - `GLOBAL_CONFIG_PATH` (= `~/.keel/config.json`), `readGlobalConfig(path?)` (throws mentioning `keel setup` when missing), `writeGlobalConfig(cfg, path?)`
  - `makeClients(region: string): AwsClients` — `{ cfn, ddb, ssm, codebuild, ecs, ec2, logs, sts }` where `ddb` is a `DynamoDBDocumentClient`.

- [ ] **Step 1: Install deps**

```bash
npm install @aws-sdk/client-cloudformation @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-ssm @aws-sdk/client-codebuild @aws-sdk/client-ecs @aws-sdk/client-ec2 @aws-sdk/client-cloudwatch-logs @aws-sdk/client-sts
```

- [ ] **Step 2: Write failing tests**

`tests/globalconfig.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "../src/aws/globalconfig";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");

describe("global config", () => {
  it("round-trips", () => {
    const p = tmpPath();
    writeGlobalConfig({ region: "ap-south-1" }, p);
    expect(readGlobalConfig(p)).toEqual({ region: "ap-south-1" });
  });

  it("throws a keel-setup hint when missing", () => {
    expect(() => readGlobalConfig(tmpPath())).toThrow(/keel setup/);
  });
});
```

Run: `npx vitest run tests/globalconfig.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/aws/globalconfig.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ControlPlane {
  stackName: string;
  tableName: string;
  clusterName: string;
  ecrRepoUri: string;
  buildProject: string;
  webhookBase: string;
  taskExecRoleArn: string;
  logGroup: string;
  vpcId: string;
  subnetIds: string[];
}

export interface GlobalConfig {
  region: string;
  baseDomain?: string;
  githubTokenStored?: boolean;
  controlPlane?: ControlPlane;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".keel", "config.json");

export function readGlobalConfig(path = GLOBAL_CONFIG_PATH): GlobalConfig {
  if (!existsSync(path)) {
    throw new Error("keel is not set up on this machine — run `keel setup` first");
  }
  return JSON.parse(readFileSync(path, "utf8")) as GlobalConfig;
}

export function writeGlobalConfig(cfg: GlobalConfig, path = GLOBAL_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
```

`src/aws/clients.ts`:
```ts
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { STSClient } from "@aws-sdk/client-sts";

export interface AwsClients {
  cfn: CloudFormationClient;
  ddb: DynamoDBDocumentClient;
  ssm: SSMClient;
  codebuild: CodeBuildClient;
  ecs: ECSClient;
  ec2: EC2Client;
  logs: CloudWatchLogsClient;
  sts: STSClient;
}

export function makeClients(region: string): AwsClients {
  return {
    cfn: new CloudFormationClient({ region }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    ssm: new SSMClient({ region }),
    codebuild: new CodeBuildClient({ region }),
    ecs: new ECSClient({ region }),
    ec2: new EC2Client({ region }),
    logs: new CloudWatchLogsClient({ region }),
    sts: new STSClient({ region }),
  };
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add package.json package-lock.json src/aws tests/globalconfig.test.ts
git commit -m "feat: aws sdk deps, global config, client factory"
```

---

### Task 3: Webhook Lambda handler

**Files:**
- Create: `infra/webhook-handler.js` (CommonJS, must stay < 4096 bytes — CloudFormation ZipFile limit)
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Produces: `makeHandler(deps)` where `deps = { ddb, ssm, cb }` (each `{ send }`); `handler` (wired to real clients). Event: API Gateway v2 payload (`pathParameters.app`, `headers["x-hub-signature-256"]`, `body`, `isBase64Encoded`). Behavior: 400 missing app/sig; 204 unknown app or non-matching branch; 401 bad HMAC; 202 after writing a `queued` deploy record and starting CodeBuild with env overrides `APP, REPO_URL, BRANCH, PORT, APP_DIR, CPU, MEMORY, DEPLOY_ID`.
- Consumes (env): `TABLE`, `PROJECT`.

- [ ] **Step 1: Write failing tests**

`tests/webhook.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { makeHandler } = require("../infra/webhook-handler.js");

process.env.TABLE = "keel";
process.env.PROJECT = "keel-build";

const appItem = {
  Item: {
    PK: { S: "APP#web" }, SK: { S: "META" },
    repo: { S: "https://github.com/me/web" }, branch: { S: "main" },
    port: { N: "3000" }, cpu: { N: "256" }, memory: { N: "512" },
  },
};

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ client: string; cmd: string; input: any }> = [];
  const mk = (client: string, answers: Record<string, unknown>) => ({
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push({ client, cmd, input: c.input });
      if (cmd in answers) return answers[cmd];
      return {};
    },
  });
  return {
    calls,
    deps: {
      ddb: mk("ddb", { GetItemCommand: overrides.app ?? appItem }),
      ssm: mk("ssm", { GetParameterCommand: { Parameter: { Value: "topsecret" } } }),
      cb: mk("cb", {}),
    },
  };
}

function event(body: string, secret = "topsecret", app = "web") {
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return {
    pathParameters: { app },
    headers: { "x-hub-signature-256": sig },
    body,
    isBase64Encoded: false,
  };
}

const push = JSON.stringify({ ref: "refs/heads/main", after: "abc1234" });

describe("webhook handler", () => {
  it("starts a build on a valid signed push to the tracked branch", async () => {
    const { calls, deps } = fakeDeps();
    const res = await makeHandler(deps)(event(push));
    expect(res.statusCode).toBe(202);
    const start = calls.find((c) => c.cmd === "StartBuildCommand")!;
    expect(start.input.projectName).toBe("keel-build");
    const envs = Object.fromEntries(
      start.input.environmentVariablesOverride.map((e: any) => [e.name, e.value]),
    );
    expect(envs.APP).toBe("web");
    expect(envs.BRANCH).toBe("main");
    expect(envs.PORT).toBe("3000");
    expect(calls.find((c) => c.cmd === "PutItemCommand")!.input.Item.status.S).toBe("queued");
  });

  it("rejects a bad signature with 401 and starts nothing", async () => {
    const { calls, deps } = fakeDeps();
    const res = await makeHandler(deps)(event(push, "wrong-secret"));
    expect(res.statusCode).toBe(401);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(false);
  });

  it("ignores unknown apps (204)", async () => {
    const { deps } = fakeDeps({ app: {} });
    expect((await makeHandler(deps)(event(push))).statusCode).toBe(204);
  });

  it("ignores pushes to other branches (204)", async () => {
    const { deps } = fakeDeps();
    const other = JSON.stringify({ ref: "refs/heads/feature", after: "x" });
    expect((await makeHandler(deps)(event(other))).statusCode).toBe(204);
  });

  it("stays under CloudFormation's 4096-byte ZipFile limit", () => {
    expect(readFileSync("infra/webhook-handler.js", "utf8").length).toBeLessThan(4096);
  });
});
```

Run: `npx vitest run tests/webhook.test.ts` — Expected: FAIL (file missing).

- [ ] **Step 2: Implement**

`infra/webhook-handler.js` (CommonJS on purpose — CFN ZipFile deploys as index.js; keep compact, no comments beyond the header):
```js
// keel webhook: verify GitHub HMAC, record deploy, start CodeBuild. CJS: CFN ZipFile => index.js
"use strict";
const { createHmac, timingSafeEqual } = require("node:crypto");
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");

const makeHandler = (d) => async (evt) => {
  const T = process.env.TABLE, P = process.env.PROJECT;
  const app = evt.pathParameters && evt.pathParameters.app;
  const sig = evt.headers && evt.headers["x-hub-signature-256"];
  if (!app || !sig) return { statusCode: 400, body: "bad request" };
  const body = evt.isBase64Encoded ? Buffer.from(evt.body || "", "base64") : Buffer.from(evt.body || "");
  const rec = await d.ddb.send(new GetItemCommand({ TableName: T, Key: { PK: { S: "APP#" + app }, SK: { S: "META" } } }));
  if (!rec.Item) return { statusCode: 204 };
  const sec = (await d.ssm.send(new GetParameterCommand({ Name: "/keel/" + app + "/webhook-secret", WithDecryption: true }))).Parameter.Value;
  const want = "sha256=" + createHmac("sha256", sec).update(body).digest("hex");
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) {
    return { statusCode: 401, body: "bad signature" };
  }
  const push = JSON.parse(body.toString());
  const branch = rec.Item.branch.S;
  if (push.ref !== "refs/heads/" + branch) return { statusCode: 204 };
  const id = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  await d.ddb.send(new PutItemCommand({ TableName: T, Item: {
    PK: { S: "APP#" + app }, SK: { S: "DEPLOY#" + id },
    status: { S: "queued" }, commit: { S: push.after || "" }, updatedAt: { S: new Date().toISOString() },
  } }));
  const ev = (n, v) => ({ name: n, value: String(v), type: "PLAINTEXT" });
  await d.cb.send(new StartBuildCommand({ projectName: P, environmentVariablesOverride: [
    ev("APP", app), ev("REPO_URL", rec.Item.repo.S), ev("BRANCH", branch),
    ev("PORT", rec.Item.port.N), ev("APP_DIR", (rec.Item.dir && rec.Item.dir.S) || ""),
    ev("CPU", (rec.Item.cpu && rec.Item.cpu.N) || "256"), ev("MEMORY", (rec.Item.memory && rec.Item.memory.N) || "512"),
    ev("DEPLOY_ID", id),
  ] }));
  return { statusCode: 202, body: "build started" };
};

exports.makeHandler = makeHandler;
exports.handler = makeHandler({
  ddb: new DynamoDBClient({}),
  ssm: new SSMClient({}),
  cb: new CodeBuildClient({}),
});
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add infra/webhook-handler.js tests/webhook.test.ts
git commit -m "feat: github webhook lambda handler (inline-deployable, <4KB)"
```

---

### Task 4: Control-plane CloudFormation template + stack module

**Files:**
- Create: `infra/control-plane.yaml`, `src/aws/stack.ts`
- Test: `tests/stack.test.ts`

**Interfaces:**
- Produces:
  - `deployStack(cfn, name: string, templateBody: string, params: Record<string, string>): Promise<Record<string, string>>` — create-or-update (treats "No updates are to be performed" as success), waits for completion, returns outputs as a flat object.
  - `stackOutputs(cfn, name): Promise<Record<string, string>>`
  - Template outputs (exact keys): `TableName, ClusterName, EcrRepoUri, BuildProject, WebhookBase, TaskExecRoleArn, LogGroup`.
- Consumes: `AwsClients["cfn"]` (Task 2); `infra/webhook-handler.js` content is passed as the `WebhookCode` template parameter (Task 6 wires it).

- [ ] **Step 1: Write failing tests**

`tests/stack.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deployStack } from "../src/aws/stack";

function fakeCfn(opts: { exists: boolean; noUpdates?: boolean }) {
  const calls: string[] = [];
  const stack = {
    StackName: "keel-control-plane",
    StackStatus: opts.exists ? "UPDATE_COMPLETE" : "CREATE_COMPLETE",
    Outputs: [{ OutputKey: "TableName", OutputValue: "keel" }],
  };
  return {
    calls,
    cfn: {
      send: async (c: any) => {
        const cmd = c.constructor.name;
        calls.push(cmd);
        if (cmd === "DescribeStacksCommand") {
          if (!opts.exists && !calls.includes("CreateStackCommand")) {
            throw Object.assign(new Error("Stack does not exist"), { name: "ValidationError" });
          }
          return { Stacks: [stack] };
        }
        if (cmd === "UpdateStackCommand" && opts.noUpdates) {
          throw new Error("No updates are to be performed.");
        }
        return {};
      },
    } as any,
  };
}

describe("deployStack", () => {
  it("creates when the stack does not exist and returns outputs", async () => {
    const { calls, cfn } = fakeCfn({ exists: false });
    const out = await deployStack(cfn, "keel-control-plane", "tpl", { WebhookCode: "x" });
    expect(calls).toContain("CreateStackCommand");
    expect(out.TableName).toBe("keel");
  });

  it("updates when the stack exists and tolerates no-op updates", async () => {
    const { calls, cfn } = fakeCfn({ exists: true, noUpdates: true });
    const out = await deployStack(cfn, "keel-control-plane", "tpl", {});
    expect(calls).toContain("UpdateStackCommand");
    expect(out.TableName).toBe("keel");
  });
});

describe("control-plane template", () => {
  const tpl = readFileSync("infra/control-plane.yaml", "utf8");
  it("declares the required outputs and the WebhookCode parameter", () => {
    for (const key of [
      "TableName", "ClusterName", "EcrRepoUri", "BuildProject",
      "WebhookBase", "TaskExecRoleArn", "LogGroup", "WebhookCode",
    ]) expect(tpl).toContain(key);
  });
});
```

Run: `npx vitest run tests/stack.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 2: Write the stack module**

`src/aws/stack.ts`:
```ts
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";

type Cfn = Pick<CloudFormationClient, "send">;

export async function stackOutputs(cfn: Cfn, name: string): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  const outputs: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

async function stackExists(cfn: Cfn, name: string): Promise<boolean> {
  try {
    await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return true;
  } catch {
    return false;
  }
}

export async function deployStack(
  cfn: Cfn,
  name: string,
  templateBody: string,
  params: Record<string, string>,
): Promise<Record<string, string>> {
  const Parameters = Object.entries(params).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v }));
  const common = { StackName: name, TemplateBody: templateBody, Parameters, Capabilities: ["CAPABILITY_NAMED_IAM"] as const };
  const client = cfn as CloudFormationClient;
  if (await stackExists(cfn, name)) {
    try {
      await cfn.send(new UpdateStackCommand(common));
      await waitUntilStackUpdateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
    } catch (e) {
      if (!/No updates are to be performed/.test(String(e))) throw e;
    }
  } else {
    await cfn.send(new CreateStackCommand({ ...common, OnFailure: "DELETE" }));
    await waitUntilStackCreateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
  }
  return stackOutputs(cfn, name);
}
```

- [ ] **Step 3: Write the template**

`infra/control-plane.yaml`:
```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: keel control plane - serverless, ~$0/mo idle

Parameters:
  WebhookCode:
    Type: String
    Description: Inline source for the webhook Lambda (max 4096 chars)

Resources:
  Table:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: keel
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: PK
          AttributeType: S
        - AttributeName: SK
          AttributeType: S
      KeySchema:
        - AttributeName: PK
          KeyType: HASH
        - AttributeName: SK
          KeyType: RANGE

  Repo:
    Type: AWS::ECR::Repository
    Properties:
      RepositoryName: keel-apps

  Cluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: keel

  AppLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /keel/apps
      RetentionInDays: 30

  BuildLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /keel/build
      RetentionInDays: 14

  TaskExecRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: keel-task-exec
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal: { Service: ecs-tasks.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
      Policies:
        - PolicyName: ssm-env
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: ssm:GetParameters
                Resource: !Sub arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/keel/*

  BuildRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: keel-build
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal: { Service: codebuild.amazonaws.com }
            Action: sts:AssumeRole
      Policies:
        - PolicyName: keel-build
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: [logs:CreateLogStream, logs:PutLogEvents]
                Resource: !Sub ${BuildLogs.Arn}:*
              - Effect: Allow
                Action: ecr:GetAuthorizationToken
                Resource: "*"
              - Effect: Allow
                Action:
                  - ecr:BatchCheckLayerAvailability
                  - ecr:BatchGetImage
                  - ecr:GetDownloadUrlForLayer
                  - ecr:PutImage
                  - ecr:InitiateLayerUpload
                  - ecr:UploadLayerPart
                  - ecr:CompleteLayerUpload
                Resource: !GetAtt Repo.Arn
              - Effect: Allow
                Action: [ecs:RegisterTaskDefinition, ecs:DescribeTaskDefinition]
                Resource: "*"
              - Effect: Allow
                Action: [ecs:DescribeServices, ecs:UpdateService]
                Resource: !Sub arn:aws:ecs:${AWS::Region}:${AWS::AccountId}:service/keel/keel-*
              - Effect: Allow
                Action: iam:PassRole
                Resource: !GetAtt TaskExecRole.Arn
              - Effect: Allow
                Action: [dynamodb:UpdateItem, dynamodb:PutItem]
                Resource: !GetAtt Table.Arn
              - Effect: Allow
                Action: [ssm:GetParameter, ssm:GetParametersByPath]
                Resource: !Sub arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/keel/*

  Build:
    Type: AWS::CodeBuild::Project
    Properties:
      Name: keel-build
      ServiceRole: !GetAtt BuildRole.Arn
      TimeoutInMinutes: 30
      Artifacts: { Type: NO_ARTIFACTS }
      LogsConfig:
        CloudWatchLogs: { Status: ENABLED, GroupName: !Ref BuildLogs }
      Environment:
        ComputeType: BUILD_GENERAL1_SMALL
        Image: aws/codebuild/standard:7.0
        Type: LINUX_CONTAINER
        PrivilegedMode: true
        EnvironmentVariables:
          - { Name: ECR_URI, Value: !GetAtt Repo.RepositoryUri }
          - { Name: TABLE, Value: !Ref Table }
          - { Name: CLUSTER, Value: !Ref Cluster }
          - { Name: EXEC_ROLE, Value: !GetAtt TaskExecRole.Arn }
          - { Name: LOG_GROUP, Value: !Ref AppLogs }
      Source:
        Type: NO_SOURCE
        BuildSpec: |
          version: 0.2
          phases:
            pre_build:
              commands:
                - |
                  set -e
                  export DEPLOY_ID="${DEPLOY_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
                  export ACCOUNT=$(echo "$CODEBUILD_BUILD_ARN" | cut -d: -f5)
                  mark() { aws dynamodb update-item --table-name "$TABLE" --key "{\"PK\":{\"S\":\"APP#$APP\"},\"SK\":{\"S\":\"DEPLOY#$DEPLOY_ID\"}}" --update-expression "SET #s = :s, updatedAt = :t" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values "{\":s\":{\"S\":\"$1\"},\":t\":{\"S\":\"$(date -u +%FT%TZ)\"}}"; }
                  mark building
                  CLONE_URL="$REPO_URL"
                  TOKEN=$(aws ssm get-parameter --name /keel/github-token --with-decryption --query Parameter.Value --output text 2>/dev/null || true)
                  if [ -n "$TOKEN" ] && [ "$TOKEN" != "None" ]; then CLONE_URL=$(echo "$REPO_URL" | sed "s|https://|https://x-access-token:$TOKEN@|"); fi
                  git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" /tmp/app
                  export COMMIT=$(git -C /tmp/app rev-parse --short HEAD)
                  aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_URI%%/*}"
            build:
              commands:
                - |
                  set -e
                  cd "/tmp/app/${APP_DIR:-.}"
                  docker build -t "$ECR_URI:$APP-$COMMIT" -t "$ECR_URI:$APP" .
            post_build:
              commands:
                - |
                  set -e
                  mark() { aws dynamodb update-item --table-name "$TABLE" --key "{\"PK\":{\"S\":\"APP#$APP\"},\"SK\":{\"S\":\"DEPLOY#$DEPLOY_ID\"}}" --update-expression "SET #s = :s, updatedAt = :t" --expression-attribute-names '{"#s":"status"}' --expression-attribute-values "{\":s\":{\"S\":\"$1\"},\":t\":{\"S\":\"$(date -u +%FT%TZ)\"}}"; }
                  if [ "$CODEBUILD_BUILD_SUCCEEDING" != "1" ]; then mark failed; exit 1; fi
                  docker push "$ECR_URI:$APP-$COMMIT"
                  docker push "$ECR_URI:$APP"
                  SECRETS=$(aws ssm get-parameters-by-path --path "/keel/$APP/env" --query "Parameters[].Name" --output json | jq -c --arg r "$AWS_REGION" --arg a "$ACCOUNT" '[.[] | {name: (split("/")[-1]), valueFrom: ("arn:aws:ssm:" + $r + ":" + $a + ":parameter" + .)}]')
                  printf '{"family":"keel-%s","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"%s","memory":"%s","executionRoleArn":"%s","containerDefinitions":[{"name":"app","image":"%s:%s-%s","essential":true,"portMappings":[{"containerPort":%s}],"secrets":%s,"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"%s","awslogs-region":"%s","awslogs-stream-prefix":"%s"}}}]}' "$APP" "$CPU" "$MEMORY" "$EXEC_ROLE" "$ECR_URI" "$APP" "$COMMIT" "$PORT" "$SECRETS" "$LOG_GROUP" "$AWS_REGION" "$APP" > /tmp/taskdef.json
                  aws ecs register-task-definition --cli-input-json file:///tmp/taskdef.json
                  if [ -n "$(aws ecs describe-services --cluster "$CLUSTER" --services "keel-$APP" --query "services[?status=='ACTIVE'].serviceName" --output text)" ]; then aws ecs update-service --cluster "$CLUSTER" --service "keel-$APP" --task-definition "keel-$APP" --force-new-deployment >/dev/null; fi
                  mark live

  HookRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: keel-webhook
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: keel-webhook
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action: [dynamodb:GetItem, dynamodb:PutItem]
                Resource: !GetAtt Table.Arn
              - Effect: Allow
                Action: codebuild:StartBuild
                Resource: !GetAtt Build.Arn
              - Effect: Allow
                Action: ssm:GetParameter
                Resource: !Sub arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/keel/*/webhook-secret

  Hook:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: keel-webhook
      Runtime: nodejs20.x
      Handler: index.handler
      Timeout: 10
      Role: !GetAtt HookRole.Arn
      Environment:
        Variables:
          TABLE: !Ref Table
          PROJECT: !Ref Build
      Code:
        ZipFile: !Ref WebhookCode

  Api:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      Name: keel-hooks
      ProtocolType: HTTP

  ApiIntegration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref Api
      IntegrationType: AWS_PROXY
      IntegrationUri: !GetAtt Hook.Arn
      PayloadFormatVersion: "2.0"

  ApiRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref Api
      RouteKey: POST /hook/{app}
      Target: !Sub integrations/${ApiIntegration}

  ApiStage:
    Type: AWS::ApiGatewayV2::Stage
    Properties:
      ApiId: !Ref Api
      StageName: $default
      AutoDeploy: true

  HookPermission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref Hook
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/hook/*

Outputs:
  TableName: { Value: !Ref Table }
  ClusterName: { Value: !Ref Cluster }
  EcrRepoUri: { Value: !GetAtt Repo.RepositoryUri }
  BuildProject: { Value: !Ref Build }
  WebhookBase: { Value: !Sub "${Api.ApiEndpoint}/hook" }
  TaskExecRoleArn: { Value: !GetAtt TaskExecRole.Arn }
  LogGroup: { Value: !Ref AppLogs }
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add infra/control-plane.yaml src/aws/stack.ts tests/stack.test.ts
git commit -m "feat: control-plane cloudformation template and stack deployer"
```

---

### Task 5: Registry (apps, deploys, secrets, env)

**Files:**
- Create: `src/aws/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Produces (all functions take `deps: RegistryDeps` first):
  - `interface RegistryDeps { ddb: { send(c: any): Promise<any> }; ssm: { send(c: any): Promise<any> }; table: string }`
  - `interface AppRecord { name: string; repo: string; branch: string; port: number; dir?: string; cpu: number; memory: number; healthPath: string; createdAt: string }`
  - `interface DeployRecord { app: string; id: string; status: "queued" | "building" | "live" | "failed"; commit?: string; buildId?: string; updatedAt: string }`
  - `putApp, getApp, listApps, putDeploy, getDeploy, listDeploys(deps, app, limit=10)`
  - `ensureWebhookSecret(deps, app): Promise<string>` — returns existing SSM SecureString at `/keel/<app>/webhook-secret` or creates one from `randomBytes(32).toString("hex")`
  - `setEnvVar(deps, app, key, value)`, `unsetEnvVar(deps, app, key)`, `listEnvVars(deps, app): Promise<Record<string, string>>` — SSM SecureStrings under `/keel/<app>/env/<KEY>`
  - `newDeployId(): string` — UTC `YYYYMMDDTHHMMSSZ` (same format as the Lambda's)
- Consumes: DynamoDBDocumentClient commands from `@aws-sdk/lib-dynamodb` (`PutCommand`, `GetCommand`, `QueryCommand`, `ScanCommand`) and SSM commands.

- [ ] **Step 1: Write failing tests**

`tests/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  putApp, getApp, listDeploys, ensureWebhookSecret, setEnvVar, listEnvVars, newDeployId,
  type AppRecord,
} from "../src/aws/registry";

function fake(answers: (cmd: string, input: any) => unknown) {
  const calls: Array<{ cmd: string; input: any }> = [];
  const send = async (c: any) => {
    calls.push({ cmd: c.constructor.name, input: c.input });
    return answers(c.constructor.name, c.input) ?? {};
  };
  return { calls, deps: { ddb: { send }, ssm: { send }, table: "keel" } };
}

const app: AppRecord = {
  name: "web", repo: "https://github.com/me/web", branch: "main",
  port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "2026-07-08T00:00:00Z",
};

describe("registry", () => {
  it("putApp writes PK=APP#name SK=META", async () => {
    const { calls, deps } = fake(() => ({}));
    await putApp(deps, app);
    expect(calls[0].cmd).toBe("PutCommand");
    expect(calls[0].input.Item).toMatchObject({ PK: "APP#web", SK: "META", port: 3000 });
  });

  it("getApp returns undefined for missing apps", async () => {
    const { deps } = fake(() => ({}));
    expect(await getApp(deps, "nope")).toBeUndefined();
  });

  it("listDeploys queries newest-first with a limit", async () => {
    const { calls, deps } = fake((cmd) =>
      cmd === "QueryCommand" ? { Items: [{ PK: "APP#web", SK: "DEPLOY#20260708T000000Z", status: "live" }] } : {},
    );
    const deploys = await listDeploys(deps, "web", 5);
    expect(calls[0].input.ScanIndexForward).toBe(false);
    expect(calls[0].input.Limit).toBe(5);
    expect(deploys[0].id).toBe("20260708T000000Z");
    expect(deploys[0].status).toBe("live");
  });

  it("ensureWebhookSecret returns the existing secret", async () => {
    const { deps } = fake((cmd) =>
      cmd === "GetParameterCommand" ? { Parameter: { Value: "existing" } } : {},
    );
    expect(await ensureWebhookSecret(deps, "web")).toBe("existing");
  });

  it("ensureWebhookSecret creates a 64-hex secret when missing", async () => {
    const { calls, deps } = fake((cmd) => {
      if (cmd === "GetParameterCommand") throw Object.assign(new Error("x"), { name: "ParameterNotFound" });
      return {};
    });
    const secret = await ensureWebhookSecret(deps, "web");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const put = calls.find((c) => c.cmd === "PutParameterCommand")!;
    expect(put.input.Name).toBe("/keel/web/webhook-secret");
    expect(put.input.Type).toBe("SecureString");
  });

  it("env vars round-trip through SSM paths", async () => {
    const { calls, deps } = fake((cmd) =>
      cmd === "GetParametersByPathCommand"
        ? { Parameters: [{ Name: "/keel/web/env/API_KEY", Value: "abc" }] }
        : {},
    );
    await setEnvVar(deps, "web", "API_KEY", "abc");
    expect(calls[0].input).toMatchObject({ Name: "/keel/web/env/API_KEY", Value: "abc", Type: "SecureString", Overwrite: true });
    expect(await listEnvVars(deps, "web")).toEqual({ API_KEY: "abc" });
  });

  it("newDeployId matches the Lambda's format", () => {
    expect(newDeployId()).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
```

Run: `npx vitest run tests/registry.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

`src/aws/registry.ts`:
```ts
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, PutParameterCommand,
} from "@aws-sdk/client-ssm";

export interface RegistryDeps {
  ddb: { send(c: any): Promise<any> };
  ssm: { send(c: any): Promise<any> };
  table: string;
}

export interface AppRecord {
  name: string;
  repo: string;
  branch: string;
  port: number;
  dir?: string;
  cpu: number;
  memory: number;
  healthPath: string;
  createdAt: string;
}

export interface DeployRecord {
  app: string;
  id: string;
  status: "queued" | "building" | "live" | "failed";
  commit?: string;
  buildId?: string;
  updatedAt: string;
}

export const newDeployId = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

export async function putApp(d: RegistryDeps, app: AppRecord): Promise<void> {
  await d.ddb.send(new PutCommand({ TableName: d.table, Item: { PK: `APP#${app.name}`, SK: "META", ...app } }));
}

export async function getApp(d: RegistryDeps, name: string): Promise<AppRecord | undefined> {
  const res = await d.ddb.send(new GetCommand({ TableName: d.table, Key: { PK: `APP#${name}`, SK: "META" } }));
  if (!res.Item) return undefined;
  const { PK, SK, ...app } = res.Item;
  return app as AppRecord;
}

export async function listApps(d: RegistryDeps): Promise<AppRecord[]> {
  // ponytail: Scan is fine — the table holds tens of items, not millions
  const res = await d.ddb.send(new ScanCommand({
    TableName: d.table,
    FilterExpression: "SK = :meta",
    ExpressionAttributeValues: { ":meta": "META" },
  }));
  return (res.Items ?? []).map(({ PK, SK, ...app }: any) => app as AppRecord);
}

export async function putDeploy(d: RegistryDeps, dep: DeployRecord): Promise<void> {
  const { app, id, ...rest } = dep;
  await d.ddb.send(new PutCommand({
    TableName: d.table,
    Item: { PK: `APP#${app}`, SK: `DEPLOY#${id}`, ...rest },
  }));
}

export async function getDeploy(d: RegistryDeps, app: string, id: string): Promise<DeployRecord | undefined> {
  const res = await d.ddb.send(new GetCommand({ TableName: d.table, Key: { PK: `APP#${app}`, SK: `DEPLOY#${id}` } }));
  if (!res.Item) return undefined;
  const { PK, SK, ...rest } = res.Item;
  return { app, id, ...rest } as DeployRecord;
}

export async function listDeploys(d: RegistryDeps, app: string, limit = 10): Promise<DeployRecord[]> {
  const res = await d.ddb.send(new QueryCommand({
    TableName: d.table,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :d)",
    ExpressionAttributeValues: { ":pk": `APP#${app}`, ":d": "DEPLOY#" },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (res.Items ?? []).map((it: any) => {
    const { PK, SK, ...rest } = it;
    return { app, id: String(SK).slice("DEPLOY#".length), ...rest } as DeployRecord;
  });
}

export async function ensureWebhookSecret(d: RegistryDeps, app: string): Promise<string> {
  const name = `/keel/${app}/webhook-secret`;
  try {
    const res = await d.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter.Value as string;
  } catch (e: any) {
    if (e?.name !== "ParameterNotFound") throw e;
    const secret = randomBytes(32).toString("hex");
    await d.ssm.send(new PutParameterCommand({ Name: name, Value: secret, Type: "SecureString" }));
    return secret;
  }
}

const envPath = (app: string) => `/keel/${app}/env`;

export async function setEnvVar(d: RegistryDeps, app: string, key: string, value: string): Promise<void> {
  await d.ssm.send(new PutParameterCommand({
    Name: `${envPath(app)}/${key}`, Value: value, Type: "SecureString", Overwrite: true,
  }));
}

export async function unsetEnvVar(d: RegistryDeps, app: string, key: string): Promise<void> {
  await d.ssm.send(new DeleteParameterCommand({ Name: `${envPath(app)}/${key}` }));
}

export async function listEnvVars(d: RegistryDeps, app: string): Promise<Record<string, string>> {
  const res = await d.ssm.send(new GetParametersByPathCommand({ Path: envPath(app), WithDecryption: true }));
  const out: Record<string, string> = {};
  for (const p of res.Parameters ?? []) out[String(p.Name).split("/").pop()!] = p.Value as string;
  return out;
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add src/aws/registry.ts tests/registry.test.ts
git commit -m "feat: dynamodb/ssm registry for apps, deploys, secrets, env"
```

---

### Task 6: `keel setup` command

**Files:**
- Create: `src/commands/setup.ts`
- Modify: `src/program.ts` (register `setup`)
- Test: `tests/setup.test.ts`, `tests/program.test.ts` (extend the registered-commands list)

**Interfaces:**
- Consumes: `deployStack` (Task 4), `writeGlobalConfig`/`GlobalConfig` (Task 2), `makeClients`.
- Produces: `setupCommand(opts, io?)` where `opts = { region?, domain?, githubToken?, yes? }` and `io = { clients?: AwsClients; configPath?: string }` for tests. Flow: STS identity check (friendly error naming `aws configure` on failure) → resolve region (flag → `AWS_REGION` env → prompt, default `ap-south-1`) → discover default VPC + its subnets via EC2 → read `infra/control-plane.yaml` + `infra/webhook-handler.js`, deploy stack with `WebhookCode` param → optionally store GitHub token at SSM `/keel/github-token` → write global config with `controlPlane` populated from outputs → print webhook base URL.
- Template/handler file resolution: `new URL("../../infra/control-plane.yaml", import.meta.url)` (works from both `src/` via tsx and `dist/`).

- [ ] **Step 1: Write failing tests**

`tests/setup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand } from "../src/commands/setup";

function fakeClients() {
  const calls: Array<{ client: string; cmd: string; input: any }> = [];
  const mk = (client: string, answers: Record<string, unknown>) => ({
    send: async (c: any) => {
      calls.push({ client, cmd: c.constructor.name, input: c.input });
      return answers[c.constructor.name] ?? {};
    },
  });
  const outputs = [
    { OutputKey: "TableName", OutputValue: "keel" },
    { OutputKey: "ClusterName", OutputValue: "keel" },
    { OutputKey: "EcrRepoUri", OutputValue: "1.dkr.ecr.x.amazonaws.com/keel-apps" },
    { OutputKey: "BuildProject", OutputValue: "keel-build" },
    { OutputKey: "WebhookBase", OutputValue: "https://api.example.com/hook" },
    { OutputKey: "TaskExecRoleArn", OutputValue: "arn:aws:iam::1:role/keel-task-exec" },
    { OutputKey: "LogGroup", OutputValue: "/keel/apps" },
  ];
  return {
    calls,
    clients: {
      sts: mk("sts", { GetCallerIdentityCommand: { Account: "111122223333" } }),
      ec2: mk("ec2", {
        DescribeVpcsCommand: { Vpcs: [{ VpcId: "vpc-123" }] },
        DescribeSubnetsCommand: { Subnets: [{ SubnetId: "subnet-a" }, { SubnetId: "subnet-b" }] },
      }),
      ssm: mk("ssm", {}),
      cfn: mk("cfn", {
        DescribeStacksCommand: { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: outputs }] },
      }),
    } as any,
  };
}

describe("setupCommand", () => {
  it("deploys the stack with the webhook code and writes global config", async () => {
    const { calls, clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand({ region: "ap-south-1", yes: true }, { clients, configPath });

    const create = calls.find((c) => ["CreateStackCommand", "UpdateStackCommand"].includes(c.cmd));
    expect(create).toBeDefined();
    const webhookParam = create!.input.Parameters.find((p: any) => p.ParameterKey === "WebhookCode");
    expect(webhookParam.ParameterValue).toContain("makeHandler");

    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.region).toBe("ap-south-1");
    expect(cfg.controlPlane.tableName).toBe("keel");
    expect(cfg.controlPlane.vpcId).toBe("vpc-123");
    expect(cfg.controlPlane.subnetIds).toEqual(["subnet-a", "subnet-b"]);
    expect(cfg.controlPlane.webhookBase).toBe("https://api.example.com/hook");
  });

  it("stores a github token in SSM when provided", async () => {
    const { calls, clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand({ region: "ap-south-1", githubToken: "ghp_x", yes: true }, { clients, configPath });
    const put = calls.find((c) => c.client === "ssm" && c.cmd === "PutParameterCommand")!;
    expect(put.input).toMatchObject({ Name: "/keel/github-token", Type: "SecureString", Overwrite: true });
  });

  it("fails with an aws-configure hint when credentials are absent", async () => {
    const { clients } = fakeClients();
    (clients as any).sts = { send: async () => { throw new Error("Could not load credentials"); } };
    await expect(
      setupCommand({ region: "ap-south-1", yes: true }, { clients, configPath: "/dev/null" }),
    ).rejects.toThrow(/aws configure/);
  });
});
```

Run: `npx vitest run tests/setup.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

`src/commands/setup.ts`:
```ts
import { readFileSync } from "node:fs";
import { input } from "@inquirer/prompts";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { makeClients, type AwsClients } from "../aws/clients.js";
import { GLOBAL_CONFIG_PATH, writeGlobalConfig } from "../aws/globalconfig.js";
import { deployStack } from "../aws/stack.js";

export interface SetupOpts {
  region?: string;
  domain?: string;
  githubToken?: string;
  yes?: boolean;
}

const STACK = "keel-control-plane";

export async function setupCommand(
  opts: SetupOpts,
  io: { clients?: AwsClients; configPath?: string } = {},
): Promise<void> {
  const region =
    opts.region ?? process.env.AWS_REGION ??
    (opts.yes ? "ap-south-1" : await input({ message: "AWS region", default: "ap-south-1" }));
  const clients = io.clients ?? makeClients(region);

  try {
    await clients.sts.send(new GetCallerIdentityCommand({}));
  } catch {
    throw new Error(
      "AWS credentials not found or invalid. Run `aws configure` (or set AWS_PROFILE) and re-run `keel setup`.",
    );
  }

  const vpcs = await clients.ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }));
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("no default VPC found in this region — create one (VPC console → Create default VPC) and re-run");
  const subnets = await clients.ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
  const subnetIds = (subnets.Subnets ?? []).map((s) => s.SubnetId!).slice(0, 3);

  const template = readFileSync(new URL("../../infra/control-plane.yaml", import.meta.url), "utf8");
  const webhookCode = readFileSync(new URL("../../infra/webhook-handler.js", import.meta.url), "utf8");
  console.log(`deploying stack ${STACK} to ${region} (first run takes ~3 minutes)…`);
  const outputs = await deployStack(clients.cfn, STACK, template, { WebhookCode: webhookCode });

  if (opts.githubToken) {
    await clients.ssm.send(new PutParameterCommand({
      Name: "/keel/github-token", Value: opts.githubToken, Type: "SecureString", Overwrite: true,
    }));
  }

  writeGlobalConfig(
    {
      region,
      ...(opts.domain ? { baseDomain: opts.domain } : {}),
      githubTokenStored: Boolean(opts.githubToken),
      controlPlane: {
        stackName: STACK,
        tableName: outputs.TableName,
        clusterName: outputs.ClusterName,
        ecrRepoUri: outputs.EcrRepoUri,
        buildProject: outputs.BuildProject,
        webhookBase: outputs.WebhookBase,
        taskExecRoleArn: outputs.TaskExecRoleArn,
        logGroup: outputs.LogGroup,
        vpcId,
        subnetIds,
      },
    },
    io.configPath ?? GLOBAL_CONFIG_PATH,
  );

  console.log(`keel is set up. webhook base: ${outputs.WebhookBase}`);
}
```

In `src/program.ts`, add (with the other commands; import `setupCommand` from `./commands/setup.js`):
```ts
  program
    .command("setup")
    .description("one-time: deploy the keel control plane into your AWS account")
    .option("--region <region>")
    .option("--domain <domain>", "base domain for app URLs (stored now, wired in Plan B2)")
    .option("--github-token <token>", "token for cloning private repos (stored in SSM)")
    .option("--yes", "non-interactive: accept defaults")
    .action((opts) => setupCommand(opts));
```

Extend the registered-commands test in `tests/program.test.ts` to include `"setup"`.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add src/commands/setup.ts src/program.ts tests/setup.test.ts tests/program.test.ts
git commit -m "feat: keel setup deploys the control plane and writes global config"
```

---

### Task 7: AWS target — register, deploy, status, env

**Files:**
- Create: `src/targets/aws.ts`
- Modify: `src/program.ts` (aws paths for `new`/`deploy`/`env`; add `status`)
- Test: `tests/aws-target.test.ts`, `tests/program.test.ts` (add `"status"`)

**Interfaces:**
- Produces (in `src/targets/aws.ts`):
  - `awsDeps(io?)` — reads global config (throws `keel setup` hint if `controlPlane` missing), returns `{ gcfg, clients, reg: RegistryDeps }`. Accepts `{ gcfg, clients }` override for tests.
  - `registerAwsApp(cfg: AppConfig, io?): Promise<void>` — `putApp` (cpu 256 / memory 512 defaults), `ensureWebhookSecret`, prints webhook URL `<webhookBase>/<app>`, the secret, and a ready-to-run `gh api` one-liner to create the GitHub webhook (content type `application/json`).
  - `deployAws(cfg: AppConfig, io?): Promise<void>` — ensure registered (auto-register if `getApp` undefined), `putDeploy` queued with `newDeployId()`, StartBuild with the same env overrides as the Lambda, then poll `getDeploy` every 5s (max 20 min) printing status transitions; throws on `failed` (message includes the CodeBuild console URL built from region + buildId when available).
  - `statusAws(cfg, io?)` — prints last 10 deploys (`id  status  commit  updatedAt`).
  - `envAws(action, pairs, cfg, io?)` — set/unset/list via registry; prints "takes effect on next deploy" after mutations.
- Wiring in `src/program.ts`:
  - `new` action: after `newCommand(opts)`, `loadAppConfig(cwd)`; if target aws → `registerAwsApp(cfg)`.
  - `deploy` action: target aws → `deployAws(cfg)` (replaces the `localOnly` throw); local unchanged.
  - `env` action: target aws → `envAws(...)`; local unchanged.
  - New `status` command: target aws → `statusAws`; local → print `listLocal()` lines.
  - `logs`/`destroy` keep the `localOnly` throw, message updated to name Plan B2.
- Poll sleep must be injectable (`io.sleep`) so tests don't wait.

- [ ] **Step 1: Write failing tests**

`tests/aws-target.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deployAws, registerAwsApp } from "../src/targets/aws";
import type { AppConfig } from "../src/config";

const cfg: AppConfig = {
  name: "web", branch: "main", port: 3000, target: "aws",
  env: {}, healthPath: "/", repo: "https://github.com/me/web",
};

const gcfg = {
  region: "ap-south-1",
  controlPlane: {
    stackName: "keel-control-plane", tableName: "keel", clusterName: "keel",
    ecrRepoUri: "1.dkr.ecr.x/keel-apps", buildProject: "keel-build",
    webhookBase: "https://api.example.com/hook",
    taskExecRoleArn: "arn:x", logGroup: "/keel/apps", vpcId: "vpc-1", subnetIds: ["s-1"],
  },
} as any;

function fakeIo(deployStatuses: string[]) {
  const calls: Array<{ cmd: string; input: any }> = [];
  let statusIdx = 0;
  const send = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetParameterCommand") return { Parameter: { Value: "secret" } };
    if (cmd === "GetCommand") {
      if (String(c.input.Key.SK) === "META") return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t" } };
      const status = deployStatuses[Math.min(statusIdx++, deployStatuses.length - 1)];
      return { Item: { PK: "APP#web", SK: c.input.Key.SK, status, updatedAt: "t" } };
    }
    if (cmd === "StartBuildCommand") return { build: { id: "keel-build:abc123" } };
    return {};
  };
  const clients = { ddb: { send }, ssm: { send }, codebuild: { send } } as any;
  return { calls, io: { gcfg, clients, sleep: async () => {} } };
}

describe("deployAws", () => {
  it("queues a deploy, starts the build with env overrides, and resolves on live", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    await deployAws(cfg, io);
    const start = calls.find((c) => c.cmd === "StartBuildCommand")!;
    const envs = Object.fromEntries(start.input.environmentVariablesOverride.map((e: any) => [e.name, e.value]));
    expect(start.input.projectName).toBe("keel-build");
    expect(envs.APP).toBe("web");
    expect(envs.PORT).toBe("3000");
    expect(envs.DEPLOY_ID).toMatch(/^\d{8}T\d{6}Z$/);
    const queued = calls.find((c) => c.cmd === "PutCommand" && String(c.input.Item.SK).startsWith("DEPLOY#"))!;
    expect(queued.input.Item.status).toBe("queued");
  });

  it("throws with the codebuild console hint when the build fails", async () => {
    const { io } = fakeIo(["building", "failed"]);
    await expect(deployAws(cfg, io)).rejects.toThrow(/codebuild/i);
  });
});

describe("registerAwsApp", () => {
  it("registers the app and prints the webhook url + gh one-liner", async () => {
    const { calls, io } = fakeIo([]);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await registerAwsApp(cfg, io);
    } finally {
      console.log = orig;
    }
    expect(calls.some((c) => c.cmd === "PutCommand" && c.input.Item.SK === "META")).toBe(true);
    const text = logs.join("\n");
    expect(text).toContain("https://api.example.com/hook/web");
    expect(text).toContain("gh api repos/me/web/hooks");
  });
});
```

Run: `npx vitest run tests/aws-target.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

`src/targets/aws.ts`:
```ts
import { StartBuildCommand } from "@aws-sdk/client-codebuild";
import type { AppConfig } from "../config.js";
import { makeClients, type AwsClients } from "../aws/clients.js";
import { readGlobalConfig, type GlobalConfig } from "../aws/globalconfig.js";
import {
  ensureWebhookSecret, getApp, getDeploy, listDeploys, listEnvVars, newDeployId,
  putApp, putDeploy, setEnvVar, unsetEnvVar, type RegistryDeps,
} from "../aws/registry.js";

export interface AwsIo {
  gcfg?: GlobalConfig;
  clients?: AwsClients;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function awsDeps(io: AwsIo = {}) {
  const gcfg = io.gcfg ?? readGlobalConfig();
  if (!gcfg.controlPlane) throw new Error("control plane missing — run `keel setup` first");
  const clients = io.clients ?? makeClients(gcfg.region);
  const reg: RegistryDeps = { ddb: clients.ddb, ssm: clients.ssm, table: gcfg.controlPlane.tableName };
  return { gcfg, clients, reg, cp: gcfg.controlPlane, sleep: io.sleep ?? defaultSleep };
}

export async function registerAwsApp(cfg: AppConfig, io: AwsIo = {}): Promise<void> {
  const { reg, cp } = awsDeps(io);
  if (!cfg.repo) throw new Error("aws apps need a github repo — set `repo` in keel.json");
  await putApp(reg, {
    name: cfg.name, repo: cfg.repo, branch: cfg.branch, port: cfg.port,
    ...(cfg.dir ? { dir: cfg.dir } : {}), cpu: 256, memory: 512,
    healthPath: cfg.healthPath, createdAt: new Date().toISOString(),
  });
  const secret = await ensureWebhookSecret(reg, cfg.name);
  const hookUrl = `${cp.webhookBase}/${cfg.name}`;
  const ownerRepo = cfg.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  console.log(`registered "${cfg.name}".`);
  console.log(`webhook URL:    ${hookUrl}`);
  console.log(`webhook secret: ${secret}`);
  console.log(`add it with:`);
  console.log(
    `  gh api repos/${ownerRepo}/hooks -f name=web -F active=true -f "events[]=push" ` +
    `-f config[url]='${hookUrl}' -f config[content_type]=application/json -f config[secret]='${secret}'`,
  );
}

function buildEnvOverrides(app: NonNullable<Awaited<ReturnType<typeof getApp>>>, deployId: string) {
  const ev = (name: string, value: unknown) => ({ name, value: String(value), type: "PLAINTEXT" as const });
  return [
    ev("APP", app.name), ev("REPO_URL", app.repo), ev("BRANCH", app.branch),
    ev("PORT", app.port), ev("APP_DIR", app.dir ?? ""),
    ev("CPU", app.cpu), ev("MEMORY", app.memory), ev("DEPLOY_ID", deployId),
  ];
}

export async function deployAws(cfg: AppConfig, io: AwsIo = {}): Promise<void> {
  const { reg, cp, gcfg, clients, sleep } = awsDeps(io);
  let app = await getApp(reg, cfg.name);
  if (!app) {
    await registerAwsApp(cfg, io);
    app = (await getApp(reg, cfg.name))!;
  }
  const id = newDeployId();
  await putDeploy(reg, { app: app.name, id, status: "queued", updatedAt: new Date().toISOString() });
  const started = await clients.codebuild.send(new StartBuildCommand({
    projectName: cp.buildProject,
    environmentVariablesOverride: buildEnvOverrides(app, id),
  }));
  const buildId: string | undefined = started.build?.id;
  console.log(`build started (${buildId ?? "id unknown"}) — waiting…`);

  const deadline = Date.now() + 20 * 60_000;
  let last = "queued";
  while (Date.now() < deadline) {
    await sleep(5000);
    const dep = await getDeploy(reg, app.name, id);
    const status = dep?.status ?? "queued";
    if (status !== last) {
      console.log(`status: ${status}`);
      last = status;
    }
    if (status === "live") {
      console.log("image pushed and task definition registered — public URL lands in Plan B2");
      return;
    }
    if (status === "failed") {
      const url = buildId
        ? `https://${gcfg.region}.console.aws.amazon.com/codesuite/codebuild/projects/${cp.buildProject}/build/${encodeURIComponent(buildId)}`
        : `CodeBuild project ${cp.buildProject}`;
      throw new Error(`deploy failed during build — see ${url}`);
    }
  }
  throw new Error("timed out waiting for the build (20m) — check the CodeBuild console");
}

export async function statusAws(cfg: AppConfig, io: AwsIo = {}): Promise<void> {
  const { reg } = awsDeps(io);
  const deploys = await listDeploys(reg, cfg.name, 10);
  if (!deploys.length) {
    console.log("no deploys yet — run `keel deploy`");
    return;
  }
  for (const d of deploys) console.log(`${d.id}  ${d.status}  ${d.commit ?? "-"}  ${d.updatedAt}`);
}

export async function envAws(
  action: "set" | "unset" | "list",
  pairs: string[],
  cfg: AppConfig,
  io: AwsIo = {},
): Promise<void> {
  const { reg } = awsDeps(io);
  if (action === "list") {
    const vars = await listEnvVars(reg, cfg.name);
    for (const [k, v] of Object.entries(vars)) console.log(`${k}=${v}`);
    return;
  }
  if (action === "set") {
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) throw new Error(`expected KEY=VALUE, got "${p}"`);
      await setEnvVar(reg, cfg.name, p.slice(0, i), p.slice(i + 1));
    }
  } else {
    for (const k of pairs) await unsetEnvVar(reg, cfg.name, k);
  }
  console.log("saved to SSM — takes effect on the next deploy");
}
```

In `src/program.ts`:
- `new` action becomes:
```ts
    .action(async (opts) => {
      await newCommand(opts);
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") await registerAwsApp(cfg);
    });
```
- `deploy` action becomes:
```ts
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        await deployAws(cfg);
        return;
      }
      const url = await deployLocal(cfg, process.cwd());
      console.log(`live: ${url}`);
    });
```
- `env` action becomes:
```ts
    .action(async (action: string, pairs: string[]) => {
      if (action !== "set" && action !== "unset" && action !== "list") {
        throw new Error(`unknown env action "${action}" — use set, unset, or list`);
      }
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") await envAws(action, pairs, cfg);
      else envCommand(action, pairs);
    });
```
- Add `status`:
```ts
  program
    .command("status")
    .description("recent deploys (aws) or running container (local)")
    .action(async () => {
      const cfg = loadAppConfig(process.cwd());
      if (cfg.target === "aws") {
        await statusAws(cfg);
        return;
      }
      const lines = await listLocal();
      console.log(lines.length ? lines.join("\n") : "no keel apps running");
    });
```
- Update `localOnly` message to: `` `this command reaches AWS in Plan B2 — use target "local" for now` `` (still used by `logs`/`destroy` only).
- Update the registered-commands test to include `"status"`.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: all PASS, clean.
```bash
git add src/targets/aws.ts src/program.ts tests/aws-target.test.ts tests/program.test.ts
git commit -m "feat: aws target - register, deploy via codebuild, status, env"
```

---

### Task 8: Live verification (REQUIRES USER — real AWS account)

**This task is executed inline by the controller with the user present, not by a subagent.** It costs a few cents of CodeBuild minutes; everything else is free tier.

**Files:** none new (README gets its status checkbox updated).

- [ ] **Step 1: User configures AWS credentials** — user runs `aws configure` (or SSO) in their own terminal with an admin/poweruser access key and confirms `aws sts get-caller-identity` works. Claude must not receive or store the keys.
- [ ] **Step 2: Run `keel setup`** — `npx tsx src/cli.ts setup --region <user's region> --github-token <fine-grained PAT with repo read>` (token needed because the keel repo is private and sample-app lives in it). Expected: stack deploys in ~3 min, webhook base printed, `~/.keel/config.json` written.
- [ ] **Step 3: Register sample-app as an AWS app** — in `sample-app/`, temporarily set `keel.json`: `target: "aws"`, `repo: "https://github.com/mayurmaed/keel"`, `dir: "sample-app"`. Run `npx tsx ../src/cli.ts new` equivalent registration via `keel deploy` auto-register, or edit + `keel deploy`. Expected: build runs, status transitions queued→building→live, image tags visible in ECR (`aws ecr list-images --repository-name keel-apps`), task definition `keel-hello` registered.
- [ ] **Step 4: Webhook round-trip** — create the webhook with the printed `gh api` one-liner, push a trivial commit to `main`, run `keel status`. Expected: a new deploy record appears and reaches `live` without the CLI being involved.
- [ ] **Step 5: Restore `sample-app/keel.json`** to `target: "local"` (keep local e2e intact), update README status checkboxes (Plan B1 done), commit:
```bash
git add sample-app/keel.json README.md
git commit -m "chore: verify aws control plane end-to-end, restore sample-app to local"
```

---

## Plan B2 preview (own plan document, after B1 ships)

Ingress stack (shared ALB, lazy-created; port-based routing without a domain, host-based + ACM + Route53 when `baseDomain` is set), per-app target group + Fargate service creation on first deploy, security groups (ALB-only ingress to tasks, public subnets per recorded deviation), `keel logs`/`destroy` for aws, live URL printing, dashboard skeleton, README. Plus the deferred Minors that fit there naturally.

## Self-review

- **Spec coverage (B1 scope):** serverless control plane ✔ (all pay-per-use resources), webhook HMAC ✔ (timing-safe compare), least-privilege IAM ✔ (scoped to `/keel/*`, table, repo, project), secrets in SSM never DynamoDB ✔ (webhook secret + env vars + github token), Dockerfile-required ✔ (buildspec does plain `docker build`), interactive CLI ✔ (setup prompts when flags absent), statuses match Lambda/buildspec/CLI ✔ (single format defined in Global Constraints).
- **Placeholder scan:** none; every step has complete code/commands.
- **Type consistency:** `RegistryDeps` shared by Lambda-equivalent test fakes and CLI; deploy-id format defined once per side and pinned by tests on both (`newDeployId` test + webhook test regex); env-override names match between `webhook-handler.js`, `buildEnvOverrides`, and the buildspec consumers.
- **Known risk accepted:** the inline buildspec and Lambda can only be fully proven against real AWS — Task 8 exists precisely for that, and runs with the user present.
