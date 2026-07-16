# Keel Phase 3: Auth (GoTrue) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `keel auth create <name> --db <db>` deploys GoTrue (Supabase Auth) as a Fargate service against a Phase-2 Postgres database, and an app with `"auth": "<name>"` in keel.json gets `GOTRUE_URL` + `JWT_SECRET` injected — delivering email+password signup/login + JWT in the user's own AWS account.

**Architecture:** Auth is a third independent resource (`AUTH#<name>` in the DynamoDB registry) referencing a database. GoTrue runs from the prebuilt public image `supabase/auth` (no CodeBuild build) as a per-auth CloudFormation stack `keel-auth-<name>`, reusing the B2 service/ALB pattern and the #15 in-stack `DbIngress` grant so it can reach Postgres before it must go healthy. JWT secret in SSM; injected into GoTrue and linked apps.

**Tech Stack:** existing stack (TypeScript strict ESM NodeNext, @aws-sdk/*, commander, @inquirer/prompts). **No new dependencies.** `supabase/auth` is a container image, not an npm package.

**Spec:** `docs/superpowers/specs/2026-07-16-keel-phase3-auth-design.md`

## Global Constraints

- No new runtime dependencies.
- TypeScript `strict: true`, ESM, `NodeNext`. Imports inside `src/` use `.js` extensions; **test files import from `../src/<name>` with NO extension** (this convention regressed repeatedly in earlier phases — check every test file).
- All AWS access via injected clients (`{ send }`); tests use fakes keyed on the command constructor name. **No test hits the network or a real GoTrue.**
- Auth name regex: `AUTH_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/` (defined in `src/config.ts`, re-exported from `src/aws/registry.ts`).
- Naming: auth stack/id `keel-auth-<name>`; SSM JWT secret `/keel/auth/<name>/jwt-secret`; GoTrue container port `9999`; health path `/health`; image param default `supabase/auth:v2.151.0`.
- Registry keys: `PK=AUTH#<name>, SK=META`. The JWT secret is **never** in DynamoDB, never logged (only its SSM location is mentioned).
- Every provisioned CloudFormation resource that supports tags carries `keel:project=<project>` (D-8).
- CLI errors: thrown `Error` with actionable message; only `src/cli.ts` catches/exits. Commands never call `process.exit`.
- Commit style: conventional commits. Tests in `tests/*.test.ts`, run with `npx vitest run`. `npx tsc --noEmit` clean before every commit.
- Branch: `phase3-auth` (already created, stacked on `phase2-database`).

---

### Task 1: Auth records in the registry + `auth` field in app config

**Files:**
- Modify: `src/aws/registry.ts`, `src/config.ts`
- Test: `tests/registry.test.ts`, `tests/config.test.ts` (append)

**Interfaces:**
- Produces in `src/config.ts`: `export const AUTH_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;`; `AppConfig` gains `auth?: string`; `validateAppConfig` rejects an `auth` value that is not a string matching `AUTH_NAME_RE`.
- Produces in `src/aws/registry.ts`:
  - re-export `AUTH_NAME_RE` from `../config.js`
  - `export interface AuthRecord { name: string; db: string; project: string; host: string; port: number; stack: string; taskSgId: string; url: string; createdAt: string; }`
  - `putAuth(d: RegistryDeps, a: AuthRecord): Promise<void>` — `Item: { PK: \`AUTH#${a.name}\`, SK: "META", ...a }`
  - `getAuth(d, name): Promise<AuthRecord | undefined>` — strips PK/SK
  - `listAuths(d): Promise<AuthRecord[]>` — Scan `FilterExpression: "SK = :meta AND begins_with(PK, :a)"`, `{ ":meta": "META", ":a": "AUTH#" }`, strips PK/SK
  - `deleteAuthRecord(d, name): Promise<void>`
  - `AppRecord` gains `auth?: string`
- Consumes: existing `RegistryDeps`, `PutCommand`/`GetCommand`/`QueryCommand`/`ScanCommand`/`DeleteCommand` from `@aws-sdk/lib-dynamodb`.

- [ ] **Step 1: Write failing tests**

Append to `tests/config.test.ts` (inside `describe("validateAppConfig")`):
```ts
  it("rejects a bad auth name and accepts a valid one", () => {
    expect(validateAppConfig({ name: "web", port: 80, target: "local", auth: "My_Auth" })).toHaveLength(1);
    expect(validateAppConfig({ name: "web", port: 80, target: "local", auth: "app-auth" })).toEqual([]);
  });
```

Append to `tests/registry.test.ts` (mirror the existing DbRecord tests; reuse the file's `fake()` helper):
```ts
import { putAuth, getAuth, listAuths, deleteAuthRecord, type AuthRecord } from "../src/aws/registry";

const auth: AuthRecord = {
  name: "appauth", db: "appdb", project: "appauth", host: "alb.example", port: 8100,
  stack: "keel-auth-appauth", taskSgId: "sg-auth", url: "http://alb.example:8100", createdAt: "t",
};

describe("auth registry", () => {
  it("putAuth writes PK=AUTH#name SK=META", async () => {
    const { calls, deps } = fake(() => ({}));
    await putAuth(deps, auth);
    expect(calls[0].cmd).toBe("PutCommand");
    expect(calls[0].input.Item).toMatchObject({ PK: "AUTH#appauth", SK: "META", db: "appdb", url: "http://alb.example:8100" });
  });

  it("getAuth returns undefined for missing", async () => {
    const { deps } = fake(() => ({}));
    expect(await getAuth(deps, "nope")).toBeUndefined();
  });

  it("listAuths scans with the AUTH# prefix filter", async () => {
    const { calls, deps } = fake((cmd) =>
      cmd === "ScanCommand" ? { Items: [{ PK: "AUTH#appauth", SK: "META", ...auth }] } : {},
    );
    const list = await listAuths(deps);
    expect(calls[0].input.FilterExpression).toMatch(/begins_with\(PK, :a\)/);
    expect(list[0].name).toBe("appauth");
  });

  it("deleteAuthRecord deletes the META item", async () => {
    const { calls, deps } = fake(() => ({}));
    await deleteAuthRecord(deps, "appauth");
    expect(calls[0].cmd).toBe("DeleteCommand");
    expect(calls[0].input.Key).toEqual({ PK: "AUTH#appauth", SK: "META" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/registry.test.ts tests/config.test.ts`
Expected: FAIL — `putAuth`/`AUTH_NAME_RE` not exported.

- [ ] **Step 3: Implement**

In `src/config.ts`: add near `DB_NAME_RE`:
```ts
export const AUTH_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
```
Add `auth?: string;` to the `AppConfig` interface. In `validateAppConfig`, append before `return errs;`:
```ts
  if (cfg?.auth !== undefined && (typeof cfg.auth !== "string" || !AUTH_NAME_RE.test(cfg.auth)))
    errs.push("auth must be a lowercase name (letters, digits, dashes), 2-32 chars");
```

In `src/aws/registry.ts`: add to the imports from `../config.js` (which already provides `DB_NAME_RE`): `AUTH_NAME_RE`, and re-export it (`export { DB_NAME_RE, AUTH_NAME_RE } ...` — match the existing re-export style). Add `auth?: string;` to `AppRecord`. Then append:
```ts
export interface AuthRecord {
  name: string;
  db: string;
  project: string;
  host: string;
  port: number;
  stack: string;
  taskSgId: string;
  url: string;
  createdAt: string;
}

export async function putAuth(d: RegistryDeps, a: AuthRecord): Promise<void> {
  await d.ddb.send(new PutCommand({ TableName: d.table, Item: { PK: `AUTH#${a.name}`, SK: "META", ...a } }));
}

export async function getAuth(d: RegistryDeps, name: string): Promise<AuthRecord | undefined> {
  const res = await d.ddb.send(new GetCommand({ TableName: d.table, Key: { PK: `AUTH#${name}`, SK: "META" } }));
  if (!res.Item) return undefined;
  const { PK, SK, ...rest } = res.Item;
  return rest as AuthRecord;
}

export async function listAuths(d: RegistryDeps): Promise<AuthRecord[]> {
  // ponytail: Scan is fine — the table holds tens of items, not millions
  const res = await d.ddb.send(new ScanCommand({
    TableName: d.table,
    FilterExpression: "SK = :meta AND begins_with(PK, :a)",
    ExpressionAttributeValues: { ":meta": "META", ":a": "AUTH#" },
  }));
  return (res.Items ?? []).map(({ PK, SK, ...rest }: any) => rest as AuthRecord);
}

export async function deleteAuthRecord(d: RegistryDeps, name: string): Promise<void> {
  await d.ddb.send(new DeleteCommand({ TableName: d.table, Key: { PK: `AUTH#${name}`, SK: "META" } }));
}
```
(Confirm `DeleteCommand` is already imported in registry.ts from `@aws-sdk/lib-dynamodb`; it is used by `deleteDbRecord`.)

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — all PASS, clean.
```bash
git add src/aws/registry.ts src/config.ts tests/registry.test.ts tests/config.test.ts
git commit -m "feat: auth records in registry, auth field in app config"
```

---

### Task 2: JWT secret helper + auth CloudFormation stack

**Files:**
- Create: `infra/auth.yaml`, `src/aws/authstack.ts`
- Test: `tests/authstack.test.ts`

**Interfaces:**
- Consumes: `deployStack` (`src/aws/stack.ts`), `AwsClients`, `GlobalConfig`, `IngressInfo` (`src/aws/ingress.ts`), the DB record's `dbSgId` + connection URL.
- Produces:
  - `ensureJwtSecret(ssm: { send(c:any): Promise<any> }, name: string): Promise<string>` — GetParameter `/keel/auth/<name>/jwt-secret` decrypt; on `ParameterNotFound` generate `randomBytes(32).toString("hex")` and PutParameter SecureString; return it. (Same ensure-pattern as `ensureWebhookSecret`.)
  - `ensureAuthStack(clients, gcfg, auth, ingress, albPort, dbSgId, dbUrlParam, jwtSecretParam): Promise<{ url: string; taskSgId: string }>` where
    - `auth`: `{ name: string; project: string }`
    - `dbUrlParam`: the SSM param name of the DB url (`/keel/db/<db>/url`)
    - `jwtSecretParam`: `/keel/auth/<name>/jwt-secret`
    - reads `infra/auth.yaml`, builds params (below), `deployStack(clients.cfn, \`keel-auth-${auth.name}\`, template, params)`, returns `{ url: out.Url, taskSgId: out.TaskSgId }`.

- [ ] **Step 1: Write failing tests** (`tests/authstack.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureJwtSecret, ensureAuthStack } from "../src/aws/authstack";

function fakeCfn(outputs: Record<string, string>) {
  const calls: any[] = [];
  const cfn = { send: async (c: any) => {
    const cmd = c.constructor.name; calls.push({ cmd, input: c.input });
    if (cmd === "DescribeStacksCommand") {
      if (!calls.some((k) => k.cmd === "CreateStackCommand"))
        throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    }
    return {};
  } };
  return { calls, cfn };
}

const gcfg = {
  region: "ap-south-1", ingress: "port",
  controlPlane: { clusterName: "keel", vpcId: "vpc-1", subnetIds: ["s-1", "s-2"], taskExecRoleArn: "arn:role", logGroup: "/keel/apps" },
} as any;
const ingress = { albDns: "alb.example", albArn: "arn:alb", albSgId: "sg-alb" } as any;

describe("ensureJwtSecret", () => {
  it("generates + stores a 64-hex secret when missing", async () => {
    const calls: any[] = [];
    const ssm = { send: async (c: any) => {
      const cmd = c.constructor.name; calls.push({ cmd, input: c.input });
      if (cmd === "GetParameterCommand") throw Object.assign(new Error("x"), { name: "ParameterNotFound" });
      return {};
    } };
    const secret = await ensureJwtSecret(ssm, "appauth");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const put = calls.find((k) => k.cmd === "PutParameterCommand");
    expect(put.input).toMatchObject({ Name: "/keel/auth/appauth/jwt-secret", Type: "SecureString" });
  });

  it("returns the existing secret", async () => {
    const ssm = { send: async (c: any) =>
      c.constructor.name === "GetParameterCommand" ? { Parameter: { Value: "existing" } } : {} };
    expect(await ensureJwtSecret(ssm, "appauth")).toBe("existing");
  });
});

describe("ensureAuthStack", () => {
  it("creates keel-auth-<name> and returns url + taskSgId", async () => {
    const { calls, cfn } = fakeCfn({ Url: "http://alb.example:8100", TaskSgId: "sg-auth" });
    const out = await ensureAuthStack({ cfn } as any, gcfg, { name: "appauth", project: "appauth" }, ingress, 8100, "sg-db", "/keel/db/appdb/url", "/keel/auth/appauth/jwt-secret");
    expect(out).toEqual({ url: "http://alb.example:8100", taskSgId: "sg-auth" });
    const create = calls.find((k) => k.cmd === "CreateStackCommand");
    const params = Object.fromEntries(create.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.AuthName).toBe("appauth");
    expect(params.DbSgId).toBe("sg-db");
    expect(params.DbUrlParam).toBe("/keel/db/appdb/url");
    expect(params.JwtSecretParam).toBe("/keel/auth/appauth/jwt-secret");
    expect(params.Project).toBe("appauth");
  });
});

describe("auth template", () => {
  const tpl = readFileSync("infra/auth.yaml", "utf8");
  it("declares a gotrue service, db ingress, target group, and outputs", () => {
    for (const k of ["supabase/auth", "9999", "/health", "DbIngress", "AWS::ECS::Service", "GOTRUE_JWT_SECRET", "GOTRUE_DB_DATABASE_URL", "keel:project", "TaskSgId", "Url"])
      expect(tpl).toContain(k);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run tests/authstack.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement `src/aws/authstack.ts`**

```ts
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import type { IngressInfo } from "./ingress.js";
import { deployStack } from "./stack.js";

export async function ensureJwtSecret(ssm: { send(c: any): Promise<any> }, name: string): Promise<string> {
  const paramName = `/keel/auth/${name}/jwt-secret`;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
    return res.Parameter.Value as string;
  } catch (e: any) {
    if (e?.name !== "ParameterNotFound") throw e;
    const secret = randomBytes(32).toString("hex");
    await ssm.send(new PutParameterCommand({ Name: paramName, Value: secret, Type: "SecureString" }));
    return secret;
  }
}

export async function ensureAuthStack(
  clients: Pick<AwsClients, "cfn">,
  gcfg: GlobalConfig,
  auth: { name: string; project: string },
  ingress: IngressInfo,
  albPort: number,
  dbSgId: string,
  dbUrlParam: string,
  jwtSecretParam: string,
): Promise<{ url: string; taskSgId: string }> {
  if (!gcfg.controlPlane) throw new Error("run `keel setup` first");
  const cp = gcfg.controlPlane;
  const template = readFileSync(new URL("../../infra/auth.yaml", import.meta.url), "utf8");
  const out = await deployStack(clients.cfn, `keel-auth-${auth.name}`, template, {
    AuthName: auth.name,
    Project: auth.project,
    Cluster: cp.clusterName,
    VpcId: cp.vpcId,
    Subnets: cp.subnetIds.join(","),
    AlbArn: ingress.albArn,
    AlbDns: ingress.albDns,
    AlbSgId: ingress.albSgId,
    Mode: gcfg.ingress,
    AlbPort: String(albPort),
    Priority: String(albPort - 8000),
    BaseDomain: gcfg.baseDomain ?? "",
    HttpsListenerArn: ingress.httpsListenerArn ?? "",
    HostedZoneId: gcfg.hostedZoneId ?? "",
    DbSgId: dbSgId,
    DbUrlParam: dbUrlParam,
    JwtSecretParam: jwtSecretParam,
    TaskExecRoleArn: cp.taskExecRoleArn,
    LogGroup: cp.logGroup,
    Image: "supabase/auth:v2.151.0",
  });
  return { url: out.Url, taskSgId: out.TaskSgId };
}
```

- [ ] **Step 4: Write `infra/auth.yaml`**

Write it in the house style of `infra/app.yaml` (short-form tags, 2-space indent), mirroring the app stack but for a prebuilt-image GoTrue service. Exact requirements:

- **Parameters:** `AuthName` (String), `Project` (String), `Cluster` (String), `VpcId` (String), `Subnets` (Type `List<AWS::EC2::Subnet::Id>`), `AlbArn`, `AlbDns`, `AlbSgId`, `Mode` (String), `AlbPort` (String, Default `"8100"`), `Priority` (String, Default `"100"`), `BaseDomain` (String, Default `""`), `HttpsListenerArn` (String, Default `""`), `HostedZoneId` (String, Default `""`), `DbSgId` (String), `DbUrlParam` (String), `JwtSecretParam` (String), `TaskExecRoleArn` (String), `LogGroup` (String), `Image` (String, Default `supabase/auth:v2.151.0`).
- **Conditions:** `IsDomain: !Equals [!Ref Mode, domain]`, `IsPort: !Equals [!Ref Mode, port]`, `HasDb: !Not [!Equals [!Ref DbSgId, ""]]`.
- **Resources:**
  - `TaskSg` (`AWS::EC2::SecurityGroup`): ingress tcp `9999`→`9999` from `SourceSecurityGroupId: !Ref AlbSgId`; `Tags: [{ Key: "keel:project", Value: !Ref Project }]`.
  - `DbIngress` (Condition `HasDb`, `AWS::EC2::SecurityGroupIngress`): `GroupId: !Ref DbSgId`, tcp `5432`, `SourceSecurityGroupId: !Ref TaskSg`, `Description: !Sub "keel:auth:${AuthName}"`.
  - `TaskDef` (`AWS::ECS::TaskDefinition`): `Family: !Sub "keel-auth-${AuthName}"`, `NetworkMode: awsvpc`, `RequiresCompatibilities: [FARGATE]`, `Cpu: "256"`, `Memory: "512"`, `ExecutionRoleArn: !Ref TaskExecRoleArn`, one container:
    - `Name: auth`, `Image: !Ref Image`, `Essential: true`, `PortMappings: [{ ContainerPort: 9999 }]`.
    - `Environment`: `GOTRUE_DB_DRIVER=postgres`, `GOTRUE_API_HOST=0.0.0.0`, `PORT=9999`, `GOTRUE_JWT_EXP=3600`, `GOTRUE_JWT_AUD=authenticated`, `GOTRUE_MAILER_AUTOCONFIRM=true`, `GOTRUE_DISABLE_SIGNUP=false`, `GOTRUE_EXTERNAL_EMAIL_ENABLED=true`, `GOTRUE_EXTERNAL_PHONE_ENABLED=false`, `GOTRUE_SITE_URL` = `!If [IsPort, !Sub "http://${AlbDns}:${AlbPort}", !Sub "https://auth-${AuthName}.${BaseDomain}"]`.
    - `Secrets`: `[{ Name: GOTRUE_JWT_SECRET, ValueFrom: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${JwtSecretParam}" }, { Name: GOTRUE_DB_DATABASE_URL, ValueFrom: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${DbUrlParam}" }]`.
    - `LogConfiguration`: `awslogs`, options group `!Ref LogGroup`, region `!Ref AWS::Region`, stream-prefix `!Sub "auth-${AuthName}"`.
  - `TargetGroup` (`AWS::ElasticLoadBalancingV2::TargetGroup`): `TargetType: ip`, `Protocol: HTTP`, `Port: 9999`, `VpcId: !Ref VpcId`, `HealthCheckProtocol: HTTP`, `HealthCheckPath: /health`, `Matcher: { HttpCode: "200-399" }`.
  - `PortListener` (Condition `IsPort`, `AWS::ElasticLoadBalancingV2::Listener`): `LoadBalancerArn: !Ref AlbArn`, `Port: !Ref AlbPort`, `Protocol: HTTP`, default forward to `TargetGroup`.
  - `DomainRule` (Condition `IsDomain`, `AWS::ElasticLoadBalancingV2::ListenerRule`): `ListenerArn: !Ref HttpsListenerArn`, `Priority: !Ref Priority`, host-header `!Sub "auth-${AuthName}.${BaseDomain}"`, forward to `TargetGroup`.
  - `DnsRecord` (Condition `IsDomain`, `AWS::Route53::RecordSet`): `HostedZoneId: !Ref HostedZoneId`, `Name: !Sub "auth-${AuthName}.${BaseDomain}"`, `Type: CNAME`, `TTL: "300"`, `ResourceRecords: [!Ref AlbDns]`.
  - `ServicePort` (Condition `IsPort`, `AWS::ECS::Service`, `DependsOn: PortListener`) and `ServiceDomain` (Condition `IsDomain`, `DependsOn: DomainRule`) — identical Properties except Condition/DependsOn: `Cluster: !Ref Cluster`, `ServiceName: !Sub "keel-auth-${AuthName}"`, `TaskDefinition: !Ref TaskDef`, `DesiredCount: 1`, `LaunchType: FARGATE`, `HealthCheckGracePeriodSeconds: 60`, `NetworkConfiguration: { AwsvpcConfiguration: { Subnets: !Ref Subnets, SecurityGroups: [!Ref TaskSg], AssignPublicIp: ENABLED } }`, `LoadBalancers: [{ TargetGroupArn: !Ref TargetGroup, ContainerName: auth, ContainerPort: 9999 }]`.
- **Outputs:** `Url: { Value: !If [IsPort, !Sub "http://${AlbDns}:${AlbPort}", !Sub "https://auth-${AuthName}.${BaseDomain}"] }`, `TaskSgId: { Value: !GetAtt TaskSg.GroupId }`.

> Notes: this is the app-stack pattern (`infra/app.yaml`), with the container image supplied directly (no ECR/CodeBuild), port 9999, health `/health`, and GoTrue's env/secrets. `DependsOn` on the services and the split-per-mode idiom come straight from the #15 fix / B2. The `Secrets` `ValueFrom` ARNs are built from the SSM param names; the `keel-task-exec` role (already granted `ssm:GetParameters` on `/keel/*`) can read them.

YAML sanity after writing:
```
python3 -c "import yaml; yaml.add_multi_constructor('!', lambda l,s,n: None, Loader=yaml.SafeLoader); d=yaml.load(open('infra/auth.yaml'), Loader=yaml.SafeLoader); print('services:', [k for k,v in d['Resources'].items() if v['Type']=='AWS::ECS::Service'], 'DbIngress:', 'DbIngress' in d['Resources'])"
```
Expected: both services + `DbIngress: True`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — all PASS, clean.
```bash
git add infra/auth.yaml src/aws/authstack.ts tests/authstack.test.ts
git commit -m "feat: gotrue auth stack (prebuilt image service) + jwt secret helper"
```

---

### Task 3: `keel auth` command family

**Files:**
- Create: `src/commands/auth.ts`
- Modify: `src/program.ts`
- Test: `tests/auth-commands.test.ts`, `tests/program.test.ts` (add `"auth"`)

**Interfaces:**
- Consumes: `awsDeps` (`src/targets/aws.ts`), `ensureIngress` (`src/aws/ingress.ts`), `ensureJwtSecret`/`ensureAuthStack` (Task 2), `getDb`/`getAuth`/`listAuths`/`putAuth`/`deleteAuthRecord`/`listApps` (registry), `AUTH_NAME_RE`.
- Produces `src/commands/auth.ts` exports (each takes `io: AwsIo = {}`):
  - `authCreate(name, opts: { db?: string; project?: string }, io?)`
  - `authList(io?)`, `authUrl(name, io?)`, `authDestroy(name, io?)`

- [ ] **Step 1: Write failing tests** (`tests/auth-commands.test.ts`) — build fakes like `tests/db-commands.test.ts` (send keyed on constructor name; cfn Describe-throws-until-Create; ssm/ddb/ec2). Cover:
  - `authCreate("appauth", { db: "appdb" }, io)` with a fake `getDb` returning a DbRecord (dbSgId "sg-db") → asserts: CreateStack `keel-auth-appauth`; a `PutParameterCommand` for `/keel/auth/appauth/jwt-secret` (SecureString) when absent; a `PutCommand` writing `AUTH#appauth` with `db: "appdb"`; the printed URL contains `http://`.
  - `authCreate` with a missing `--db` → rejects `/--db/`; with a non-existent db (getDb undefined) → rejects `/keel db create/`.
  - invalid name `App_Auth` → rejects before any AWS call.
  - `authDestroy("appauth", io)` → DeleteStack `keel-auth-appauth` + DeleteParameter `/keel/auth/appauth/jwt-secret` + DeleteCommand `AUTH#appauth`.
  - allocation: `authCreate` picks an ALB port that does not collide with app ports — port range starts at **8100** for auth (apps use 8001+). Assert the CreateStack `AlbPort` param is `>= 8100`.
  - `tests/program.test.ts` registers `"auth"`.

- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run` → FAIL.

- [ ] **Step 3: Implement `src/commands/auth.ts`**

```ts
import { GetParameterCommand, PutParameterCommand, DeleteParameterCommand } from "@aws-sdk/client-ssm";
import { DeleteStackCommand, waitUntilStackDeleteComplete, CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { awsDeps, type AwsIo } from "../targets/aws.js";
import { ensureIngress } from "../aws/ingress.js";
import { ensureJwtSecret, ensureAuthStack } from "../aws/authstack.js";
import { getDb, getAuth, listAuths, putAuth, deleteAuthRecord, AUTH_NAME_RE } from "../aws/registry.js";

// auth ALB ports start at 8100 (apps use 8001-8099-ish); priority = albPort - 8000.
function nextAuthPort(used: number[]): number {
  const authPorts = used.filter((p) => p >= 8100);
  return authPorts.length ? Math.max(...authPorts) + 1 : 8100;
}

export async function authCreate(
  name: string,
  opts: { db?: string; project?: string } = {},
  io: AwsIo = {},
): Promise<void> {
  if (!AUTH_NAME_RE.test(name)) throw new Error(`invalid auth name "${name}" — lowercase letters, digits, dashes, 2-32 chars`);
  if (!opts.db) throw new Error("auth needs a database — pass --db <name> (create one with `keel db create <name>`)");
  const { gcfg, clients, reg } = awsDeps(io);
  if (await getAuth(reg, name)) throw new Error(`auth "${name}" already exists`);
  const db = await getDb(reg, opts.db);
  if (!db) throw new Error(`database "${opts.db}" not found — create it with \`keel db create ${opts.db}\``);

  const auths = await listAuths(reg);
  const albPort = nextAuthPort(auths.map((a) => a.port).filter((p): p is number => typeof p === "number"));
  const ingress = await ensureIngress(clients, gcfg);
  const jwtSecretParam = `/keel/auth/${name}/jwt-secret`;
  await ensureJwtSecret(clients.ssm, name); // ensure it exists before the stack references it
  const { url, taskSgId } = await ensureAuthStack(
    clients, gcfg, { name, project: opts.project ?? name }, ingress, albPort,
    db.dbSgId, `/keel/db/${opts.db}/url`, jwtSecretParam,
  );
  await putAuth(reg, {
    name, db: opts.db, project: opts.project ?? name,
    host: new URL(url).host, port: albPort, stack: `keel-auth-${name}`, taskSgId, url,
    createdAt: new Date().toISOString(),
  });
  console.log(`auth "${name}" ready: ${url}`);
  console.log(`JWT secret in SSM: ${jwtSecretParam}`);
  console.log(`link an app by adding "auth": "${name}" to its keel.json`);
}

export async function authList(io: AwsIo = {}): Promise<void> {
  const { reg } = awsDeps(io);
  const list = await listAuths(reg);
  if (!list.length) { console.log("no auth services — create one with `keel auth create <name> --db <db>`"); return; }
  for (const a of list) console.log(`${a.name}  ${a.db}  ${a.project}  ${a.url}`);
}

export async function authUrl(name: string, io: AwsIo = {}): Promise<void> {
  const { reg } = awsDeps(io);
  const a = await getAuth(reg, name);
  if (!a) throw new Error(`auth "${name}" not found — create it with \`keel auth create ${name} --db <db>\``);
  console.log(a.url);
}

export async function authDestroy(name: string, io: AwsIo = {}): Promise<void> {
  const { reg, clients } = awsDeps(io);
  const a = await getAuth(reg, name);
  if (!a) throw new Error(`auth "${name}" is not registered — nothing to destroy`);
  const stackName = `keel-auth-${name}`;
  await clients.cfn.send(new DeleteStackCommand({ StackName: stackName }));
  // waiter: delete faster than create; the app stack pattern uses the same cast.
  await waitUntilStackDeleteComplete({ client: clients.cfn as CloudFormationClient, maxWaitTime: 900 }, { StackName: stackName });
  await clients.ssm.send(new DeleteParameterCommand({ Name: `/keel/auth/${name}/jwt-secret` })).catch(() => {});
  await deleteAuthRecord(reg, name);
  console.log(`destroyed auth ${name} (database and its auth schema left intact)`);
}
```

Wire in `src/program.ts` (mirror the `db` group; import `confirm` is already used by destroy commands):
```ts
  const auth = program.command("auth").description("managed authentication (GoTrue) services");
  auth.command("create <name>")
    .requiredOption("--db <db>", "the keel database to store users in")
    .option("--project <project>")
    .action((name: string, opts: { db: string; project?: string }) => authCreate(name, opts));
  auth.command("list").action(() => authList());
  auth.command("url <name>").action((name: string) => authUrl(name));
  auth.command("destroy <name>").option("--yes", "skip confirmation")
    .action(async (name: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm({ message: `Destroy auth "${name}"? Users stay in the database, but the login service is removed.`, default: false });
        if (!ok) { console.log("aborted"); return; }
      }
      await authDestroy(name);
    });
```
Extend the registered-commands test to include `"auth"`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — all PASS, clean.
```bash
git add src/commands/auth.ts src/program.ts tests/auth-commands.test.ts tests/program.test.ts
git commit -m "feat: keel auth create/list/url/destroy"
```

---

### Task 4: Deploy-time auth linking (`"auth"` → GOTRUE_URL + JWT_SECRET)

**Files:**
- Modify: `src/targets/aws.ts` (deployAws, registerAwsApp), `src/commands/new.ts` (thread `--auth`)
- Test: `tests/aws-target.test.ts` (extend)

**Interfaces:**
- `registerAwsApp` includes `auth` from cfg in the AppRecord when present (alongside the existing `db`/`project`).
- `deployAws` gains, in the same pre-build block that handles `cfg.db` (before `putDeploy`/StartBuild):
```ts
  if (cfg.auth) {
    const authRec = await getAuth(reg, cfg.auth);
    if (!authRec) throw new Error(`auth "${cfg.auth}" not found — create it with \`keel auth create ${cfg.auth} --db <db>\``);
    const jwtRes = await clients.ssm.send(new GetParameterCommand({ Name: `/keel/auth/${cfg.auth}/jwt-secret`, WithDecryption: true }));
    await setEnvVar(reg, cfg.name, "GOTRUE_URL", authRec.url);
    await setEnvVar(reg, cfg.name, "JWT_SECRET", jwtRes.Parameter!.Value as string);
  }
```
  (`getAuth` imported from `../aws/registry.js`; `GetParameterCommand`/`setEnvVar` are already imported for the db-link path.)
- `keel new` gains `--auth <name>` written into keel.json when provided (no prompt; optional; mirrors `--db`).

- [ ] **Step 1: Failing tests** — extend `tests/aws-target.test.ts`:
  - deployAws with `cfg.auth = "appauth"` and a fake `GetCommand` for `AUTH#appauth` returning an AuthRecord + ssm `GetParameterCommand` for the jwt secret: assert `PutParameterCommand` for `/keel/web/env/GOTRUE_URL` **and** `/keel/web/env/JWT_SECRET` both occur **before** `StartBuildCommand`.
  - deployAws with `cfg.auth` set but no auth record → rejects `/keel auth create/`, no build started.
  - deployAws without `cfg.auth`: no GOTRUE_URL/JWT_SECRET writes (existing tests keep passing; extend fixtures additively).

- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Implement** per the interfaces above.
- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — all PASS.
```bash
git add src/targets/aws.ts src/commands/new.ts tests/aws-target.test.ts
git commit -m "feat: deploy-time auth linking - GOTRUE_URL + JWT_SECRET injection"
```

---

### Task 5: Docs + live verification (REQUIRES USER — real AWS)

**Executed inline by the controller with the user present.** Costs a running Fargate task + the shared instance/ALB while up (~cents prorated); torn down after.

- [ ] **Step 1:** Add a "Auth (`keel auth`)" section to `docs/GUIDE.md`: `keel auth create <name> --db <db>` (what it deploys, the autoconfirm caveat + HTTPS-in-domain-mode note), `list`/`url`/`destroy`, linking via `keel.json` `"auth"`, and the signup/login curl flow. Add `keel auth *` rows to the command table. Commit.
- [ ] **Step 2 (live):** `keel setup` (if torn down) → `keel db create demo --backup-days 1` → `keel auth create demoauth --db demo`. Confirm the GoTrue stack reaches CREATE_COMPLETE and `curl <auth-url>/health` returns 200.
- [ ] **Step 3 (live):** `curl -sX POST <auth-url>/signup -H 'Content-Type: application/json' -d '{"email":"a@b.com","password":"password123"}'` → a user + `access_token`; then `curl -sX POST '<auth-url>/token?grant_type=password' -d '{"email":"a@b.com","password":"password123"}'` → a JWT. Decode it and verify the signature against the SSM secret (`node`/`jose` one-liner or `jwt` CLI). This proves signup/login/JWT end-to-end.
- [ ] **Step 4 (live):** `keel auth destroy demoauth --yes` (confirm the DB ingress rule for auth is auto-removed), then `keel db destroy demo` + tear down the shared instance/ingress/control-plane per the standing preference.
- [ ] **Step 5:** Update README status (Phase 3 auth checked) + GUIDE status line. Commit:
```bash
git commit -m "chore: verify phase 3 auth end-to-end (gotrue signup/login/JWT), update docs"
```

---

## Self-review

- **Spec coverage:** AUTH# record + `auth` field ✔ (Task 1), GoTrue-as-service from a prebuilt image + JWT secret + DbIngress + tags ✔ (Task 2), `keel auth create/list/url/destroy` ✔ (Task 3), deploy-time GOTRUE_URL/JWT_SECRET injection ✔ (Task 4), docs + live signup/login/JWT verification ✔ (Task 5), autoconfirm ✔ (`GOTRUE_MAILER_AUTOCONFIRM=true` in the template), out-of-scope items (OAuth/RLS/MFA/dashboard/SMTP) not built ✔.
- **Placeholder scan:** every code step has complete code; the YAML is a fully enumerated property spec (same approach used successfully for `infra/ingress.yaml`/`db.yaml`); commands have expected outputs.
- **Type consistency:** `AuthRecord` fields defined in Task 1 are exactly what Task 3 writes and Task 4/authUrl read; `ensureAuthStack`'s `{ url, taskSgId }` return matches Task 3's consumption; the auth ALB-port range (8100+) is distinct from the app range (8001+) so ListenerRule priorities never collide; `JwtSecretParam`/`DbUrlParam` names are consistent between Task 2 (template + module) and Task 3 (caller).
- **Known live risks (Task 5):** the `supabase/auth` image tag must be a currently-valid tag (pin at implementation); GoTrue expects the DB role to be able to create its `auth` schema (the Phase-2 DB owner role can); autoconfirm means no email verification (documented).
