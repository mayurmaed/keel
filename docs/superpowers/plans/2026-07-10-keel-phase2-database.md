# Keel Phase 2: Database (Postgres on RDS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `keel db create <name>` provisions Postgres in the user's AWS account (shared instance with logical DBs, or a dedicated instance — selectable), and an app with `"db": "<name>"` in keel.json gets `DATABASE_URL` injected and network access to exactly that database. Prerequisite: every app gets its own task security group.

**Architecture:** Databases are independent resources (`DB#<name>` in the existing DynamoDB registry) grouped by a `project` string. One CloudFormation template (`infra/db.yaml`) serves both isolation modes. Security-group ingress rules are owned entirely by the CLI via the EC2 SDK (described rules `keel:master` / `keel:app:<name>`), never by CFN parameters — so N apps can be granted access without template gymnastics. Logical DB creation runs `CREATE ROLE`/`CREATE DATABASE` over TLS via `pg` behind an injectable factory.

**Tech Stack:** existing stack + `pg` (new runtime dep) + `@aws-sdk/client-rds`? — NOT needed (RDS managed via CloudFormation through the existing cfn client). `@types/pg` dev-only.

**Spec:** `docs/superpowers/specs/2026-07-10-keel-phase2-database-design.md`

## Global Constraints

- Runtime deps: commander, @inquirer/prompts, @aws-sdk/*, **pg**. Nothing else.
- TypeScript strict ESM NodeNext; `.js` extensions inside `src/`; **extension-less test imports** (regressed 4× in B1/B2 — check every touched test file).
- All AWS access via injected clients; `pg` via an injectable `PgFactory`; `getMyIp` via injectable fetch. No test touches the network.
- DB name regex: `/^[a-z][a-z0-9_]{0,62}$/` (Postgres-safe, no quoting needed). Generated passwords are **hex-only** (`randomBytes(24).toString("hex")`) so SQL string literals never need escaping.
- Naming: shared instance stack/id `keel-db-shared`; dedicated stack/id `keel-db-<name>`; SSM: `/keel/db-shared/master`, `/keel/db/<name>/master` (dedicated), `/keel/db/<name>/url`. SG rule descriptions: `keel:master`, `keel:app:<app>`.
- Registry keys: `PK=DB#<name>, SK=META`. Connection URLs/passwords never in DynamoDB, never logged (only `keel db url` prints).
- CLI errors thrown, caught only in cli.ts; conventional commits; `npx vitest run && npx tsc --noEmit` green before every commit.

---

### Task 1: Per-app security groups (B2 refactor)

**Files:**
- Modify: `infra/app.yaml`, `infra/ingress.yaml`, `src/aws/ingress.ts`, `src/aws/appstack.ts`, `src/targets/aws.ts`
- Test: `tests/appstack.test.ts`, `tests/ingress.test.ts`, `tests/aws-target.test.ts` (adjust)

**Interfaces:**
- Consumes: existing `ensureIngress`/`ensureAppStack`/`deployAws`.
- Produces:
  - `IngressInfo` loses `taskSgId` → `{ albDns, albArn, albSgId, httpsListenerArn? }`.
  - `ensureAppStack(clients, gcfg, app, ingress, albPort)` now returns `Promise<{ url: string; taskSgId: string }>` (was `Promise<string>`).
  - `infra/app.yaml`: parameter `TaskSgId` **removed**, parameter `AlbSgId` **added**; new resource `TaskSg` (own SG per app, ingress on `ContainerPort` only from `AlbSgId`); both services use `[!Ref TaskSg]`; new output `TaskSgId: !GetAtt TaskSg.GroupId`.
  - `infra/ingress.yaml`: `TaskSg` resource and `TaskSgId` output **removed** (ALB SG only).

- [ ] **Step 1: Adjust the tests first**

In `tests/ingress.test.ts`: remove `TaskSgId` from the fake outputs and the `info.taskSgId` assertion; assert the template does NOT contain a `TaskSg` resource (`expect(tpl).not.toContain("TaskSg:")`).

In `tests/appstack.test.ts`: fake outputs now include `TaskSgId: "sg-app"`; assert `ensureAppStack(...)` resolves to `{ url: "http://alb.example:8001", taskSgId: "sg-app" }`; assert CreateStack params include `AlbSgId` and do NOT include `TaskSgId`; template-content test adds `"AWS::EC2::SecurityGroup"`.

In `tests/aws-target.test.ts`: the fake keel-app-* DescribeStacks outputs gain `TaskSgId`; the happy-path URL assertion is unchanged (deployAws prints `result.url`).

Run: `npx vitest run` — Expected: FAIL (interfaces not yet changed).

- [ ] **Step 2: Implement**

`infra/app.yaml`:
- Parameters: delete `TaskSgId`; add `AlbSgId: { Type: String }`.
- Add resource (unconditional):
```yaml
  TaskSg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: !Sub "keel app ${AppName} - ingress only from the ALB"
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: !Ref ContainerPort
          ToPort: !Ref ContainerPort
          SourceSecurityGroupId: !Ref AlbSgId
```
- In BOTH `ServicePort` and `ServiceDomain`: `SecurityGroups: [!Ref TaskSg]`.
- Outputs: add `TaskSgId: { Value: !GetAtt TaskSg.GroupId }`.

`infra/ingress.yaml`: delete the `TaskSg` resource and the `TaskSgId` output.

`src/aws/ingress.ts`: remove `taskSgId` from `IngressInfo` and the return mapping.

`src/aws/appstack.ts`: params — replace `TaskSgId: ingress.taskSgId` with `AlbSgId: ingress.albSgId`; return `{ url: out.Url, taskSgId: out.TaskSgId }`.

`src/targets/aws.ts` deployAws live branch:
```ts
      const appStack = await ensureAppStack(clients, gcfg, app, ingress, app.albPort ?? 8001);
      console.log(`live: ${appStack.url}`);
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit` — all PASS. YAML sanity-check both templates (permissive-tag loader).
```bash
git add infra/app.yaml infra/ingress.yaml src/aws/ingress.ts src/aws/appstack.ts src/targets/aws.ts tests/
git commit -m "feat: per-app task security groups (own SG per app, ALB-only ingress)"
```

---

### Task 2: DB records, name validation, keel.json `db` field

**Files:**
- Modify: `src/aws/registry.ts`, `src/config.ts`
- Test: `tests/registry.test.ts`, `tests/config.test.ts` (append)

**Interfaces:**
- Produces in `src/aws/registry.ts`:
```ts
export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export interface DbRecord {
  name: string;
  project: string;
  isolation: "shared" | "dedicated";
  access: "public";
  engine: "postgres";
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
  stack: string;
  dbSgId: string;
  createdAt: string;
}
```
  plus `putDb(deps, db)`, `getDb(deps, name)`, `listDbs(deps)`, `deleteDbRecord(deps, name)` — same patterns as the app functions (`PK=DB#<name>, SK=META`; listDbs scans `begins_with(PK, "DB#") AND SK = META`).
- **Fix `listApps`** (latent bug once DB records exist): its Scan filter is `SK = :meta`, which would now also return DB records. Change to `FilterExpression: "SK = :meta AND begins_with(PK, :app)"` with `":app": "APP#"`, and strip the `APP#` prefix exactly as before.
- `src/config.ts`: `AppConfig` gains `db?: string` and `project?: string`; `validateAppConfig` rejects a `db` not matching `DB_NAME_RE` and a non-string `project`.
- `AppRecord` gains optional `db?: string; project?: string` (registerAwsApp threads them through in Task 6).

- [ ] **Step 1: Failing tests** — append to `tests/registry.test.ts`: putDb writes `PK=DB#api, SK=META` with the record fields; getDb returns undefined on missing; listDbs scans with the `DB#` prefix filter; **listApps' Scan input now includes `begins_with(PK, :app)`**. Append to `tests/config.test.ts`: `db: "My-DB"` rejected, `db: "api_db"` accepted, `project: 5` rejected.
- [ ] **Step 2: Implement** per the interfaces above (mirror the existing app-record code; keep the ponytail Scan comment).
- [ ] **Step 3: Verify and commit**
```bash
git add src/aws/registry.ts src/config.ts tests/registry.test.ts tests/config.test.ts
git commit -m "feat: db records in registry, db/project fields in app config"
```

---

### Task 3: RDS template + instance/security modules

**Files:**
- Create: `infra/db.yaml`, `src/aws/dbstack.ts`
- Test: `tests/dbstack.test.ts`

**Interfaces:**
- `infra/db.yaml` — ONE template for both modes. Parameters: `InstanceId`, `MasterPassword` (`NoEcho: true`), `VpcId`, `Subnets` (`List<AWS::EC2::Subnet::Id>`), `DbName` (String, default `""`). Condition `HasDbName: !Not [!Equals [!Ref DbName, ""]]`. Resources: `SubnetGroup` (`AWS::RDS::DBSubnetGroup`, the public subnets), `DbSg` (`AWS::EC2::SecurityGroup`, **no ingress rules** — the CLI owns all rules via SDK), `Instance` (`AWS::RDS::DBInstance`: `DBInstanceIdentifier: !Ref InstanceId`, `Engine: postgres`, `DBInstanceClass: db.t4g.micro`, `AllocatedStorage: "20"`, `StorageType: gp3`, `MasterUsername: keeladmin`, `MasterUserPassword: !Ref MasterPassword`, `PubliclyAccessible: true`, `StorageEncrypted: true`, `BackupRetentionPeriod: 7`, `DBSubnetGroupName`, `VPCSecurityGroups: [!GetAtt DbSg.GroupId]`, `DBName: !If [HasDbName, !Ref DbName, !Ref "AWS::NoValue"]`, `DeletionPolicy: Delete` on the resource). Outputs: `Endpoint: !GetAtt Instance.Endpoint.Address`, `DbSgId: !GetAtt DbSg.GroupId`.
- `src/aws/dbstack.ts`:
```ts
export interface DbInstanceInfo { host: string; dbSgId: string; masterPassword: string; }

export async function ensureDbInstance(
  clients: Pick<AwsClients, "cfn" | "ssm">,
  gcfg: GlobalConfig,
  opts: { stackName: string; instanceId: string; masterPasswordSsm: string; dbName?: string },
): Promise<DbInstanceInfo>;
// - GetParameter(masterPasswordSsm, decrypt); on ParameterNotFound generate
//   randomBytes(24).toString("hex") and PutParameter SecureString (same
//   ensure-pattern as ensureWebhookSecret).
// - deployStack(cfn, opts.stackName, infra/db.yaml, { InstanceId, MasterPassword,
//   VpcId, Subnets: subnetIds.join(","), DbName: opts.dbName ?? "" }).
// - return { host: out.Endpoint, dbSgId: out.DbSgId, masterPassword }.

export async function getMyIp(fetchImpl: typeof fetch = fetch): Promise<string>;
// GET https://checkip.amazonaws.com, trim; validate /^\d+\.\d+\.\d+\.\d+$/ else throw actionable error.

export async function setMasterIpRule(ec2: { send(c: any): Promise<any> }, sgId: string, ip: string): Promise<void>;
// DescribeSecurityGroupRulesCommand filter group-id=sgId → revoke (RevokeSecurityGroupIngressCommand
// by SecurityGroupRuleIds) every non-egress rule whose Description === "keel:master";
// then AuthorizeSecurityGroupIngressCommand tcp 5432 CidrIp `${ip}/32` Description "keel:master",
// catching RulesPerSecurityGroupLimitExceeded/InvalidPermission.Duplicate as no-op for the duplicate case only.

export async function allowAppSg(ec2, sgId: string, appSgId: string, appName: string): Promise<void>;
// AuthorizeSecurityGroupIngressCommand tcp 5432 UserIdGroupPairs [{ GroupId: appSgId,
// Description: `keel:app:${appName}` }]; treat InvalidPermission.Duplicate as success (idempotent).
```
- EC2 commands come from `@aws-sdk/client-ec2` (already installed).

- [ ] **Step 1: Failing tests** (`tests/dbstack.test.ts`, fakes keyed on command constructor):
  - ensureDbInstance generates+stores a hex master password when missing, passes `MasterPassword` and `DbName:""` as stack params, returns host/dbSgId/password from outputs.
  - ensureDbInstance with `dbName: "api"` passes `DbName: "api"`.
  - getMyIp returns the trimmed IP from an injected fetch; throws on garbage.
  - setMasterIpRule revokes only rules described `keel:master` then authorizes the new `/32`.
  - allowAppSg authorizes the app SG pair and swallows `InvalidPermission.Duplicate` (fake throws `Object.assign(new Error("dup"), { name: "InvalidPermission.Duplicate" })` — resolves anyway).
  - Template-content test: `infra/db.yaml` contains `AWS::RDS::DBInstance`, `NoEcho`, `StorageEncrypted`, `DbSgId`.
- [ ] **Step 2: Implement** per the interfaces; YAML in the house style; sanity-check YAML.
- [ ] **Step 3: Verify and commit**
```bash
git add infra/db.yaml src/aws/dbstack.ts tests/dbstack.test.ts
git commit -m "feat: rds instance template + db stack/security-rule modules"
```

---

### Task 4: Postgres provisioning via pg

**Files:**
- Modify: `package.json` (`npm install pg && npm install -D @types/pg`)
- Create: `src/aws/pgadmin.ts`
- Test: `tests/pgadmin.test.ts`

**Interfaces:**
```ts
export interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
export type PgFactory = (url: string) => PgClient;

export const realPg: PgFactory;
// new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
// ponytail: RDS's CA isn't in node's default bundle; TLS is still enforced on the wire.
// Import the RDS CA bundle if paranoia ever demands it.

export async function createLogicalDb(factory: PgFactory, adminUrl: string, name: string, password: string): Promise<void>;
// validates name against DB_NAME_RE (throw otherwise), password against /^[0-9a-f]+$/ (hex-only, no escaping),
// connect → `CREATE ROLE "<name>" LOGIN PASSWORD '<password>'` → `CREATE DATABASE "<name>" OWNER "<name>"` → end (in finally).

export async function dropLogicalDb(factory: PgFactory, adminUrl: string, name: string): Promise<void>;
// connect → `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)` → `DROP ROLE IF EXISTS "<name>"` → end (in finally).
```

- [ ] **Step 1: Failing tests** — fake factory records `{ connected, queries, ended }`; assert the exact SQL statement sequence for create and drop; assert invalid name and non-hex password throw BEFORE connect; assert `end()` runs even when a query rejects.
- [ ] **Step 2: Implement**; install deps.
- [ ] **Step 3: Verify and commit**
```bash
git add package.json package-lock.json src/aws/pgadmin.ts tests/pgadmin.test.ts
git commit -m "feat: postgres logical-db provisioning via pg (injectable factory)"
```

---

### Task 5: `keel db` command family

**Files:**
- Create: `src/commands/db.ts`
- Modify: `src/program.ts`
- Test: `tests/db-commands.test.ts`

**Interfaces:**
- `src/commands/db.ts` exports (all take `io: DbIo = {}` where `DbIo = AwsIo & { pg?: PgFactory; fetchImpl?: typeof fetch }`):
  - `dbCreate(name, opts: { isolation?: "shared" | "dedicated"; project?: string }, io?)` —
    validate name (DB_NAME_RE, actionable error); `getDb` duplicate → error.
    **shared** (default): `ensureDbInstance({ stackName: "keel-db-shared", instanceId: "keel-db-shared", masterPasswordSsm: "/keel/db-shared/master" })` (print "first shared database provisions the instance — takes ~8 minutes" before); `setMasterIpRule(ec2, dbSgId, await getMyIp(fetchImpl))`; adminUrl `postgres://keeladmin:<master>@<host>:5432/postgres?sslmode=require`; generate hex password; `createLogicalDb`; url `postgres://<name>:<pw>@<host>:5432/<name>?sslmode=require`; dbUser `<name>`.
    **dedicated**: `ensureDbInstance({ stackName: "keel-db-<name>", instanceId: "keel-db-<name>", masterPasswordSsm: "/keel/db/<name>/master", dbName: name })`; `setMasterIpRule`; url `postgres://keeladmin:<master>@<host>:5432/<name>?sslmode=require`; dbUser `keeladmin`.
    Both: PutParameter `/keel/db/<name>/url` SecureString Overwrite; `putDb` record (project defaults to name; port 5432; stack name; dbSgId); print the url once + "connect from this machine works now; your IP is allowed. If your IP changes: keel db allow-ip".
  - `dbList(io?)` — prints `name  isolation  project  host` per record; "no databases — create one with `keel db create <name>`" when empty.
  - `dbUrl(name, io?)` — GetParameter decrypt, print value; missing → error naming `keel db create`.
  - `dbAllowIp(opts: { db?: string; ip?: string }, io?)` — resolve targets (one record or all), dedupe by `dbSgId`, `setMasterIpRule` each with `opts.ip ?? await getMyIp()`; print what changed.
  - `dbDestroy(name, io?)` — record or error. shared: read master, `dropLogicalDb(adminUrl, name)`; dedicated: DeleteStack `keel-db-<name>` + `waitUntilStackDeleteComplete` + DeleteParameter master. Both: DeleteParameter url, `deleteDbRecord`, print summary. After a shared destroy, if `listDbs` has no shared records left, print: "shared instance keel-db-shared is still running (~$13/mo) — remove it with: aws cloudformation delete-stack --stack-name keel-db-shared".
- `src/program.ts`: a `db` subcommand group:
```ts
  const db = program.command("db").description("managed postgres (rds) databases");
  db.command("create <name>")
    .option("--isolation <mode>", '"shared" (default) or "dedicated"', "shared")
    .option("--project <project>")
    .action((name, opts) => dbCreate(name, opts));
  db.command("list").action(() => dbList());
  db.command("url <name>").action((name) => dbUrl(name));
  db.command("allow-ip [ip]").option("--db <name>")
    .action((ip, opts) => dbAllowIp({ ip, db: opts.db }));
  db.command("destroy <name>").option("--yes", "skip confirmation")
    .action(async (name, opts) => {
      if (!opts.yes) {
        const ok = await confirm({ message: `Destroy database "${name}"? Data is deleted. This cannot be undone.`, default: false });
        if (!ok) { console.log("aborted"); return; }
      }
      await dbDestroy(name);
    });
```
  Registered-commands test gains `"db"`; `--isolation` values validated (`shared`/`dedicated`, else throw).

- [ ] **Step 1: Failing tests** (`tests/db-commands.test.ts`) — fakes for cfn/ssm/ec2/ddb + fake pg + fake fetch:
  - shared create: asserts stack `keel-db-shared` created, master-ip rule set, `CREATE ROLE`/`CREATE DATABASE` SQL ran, url stored at `/keel/db/api/url`, DbRecord written with isolation shared/dbUser "api".
  - dedicated create: stack `keel-db-api`, `DbName: "api"` param, no pg SQL, dbUser `keeladmin`.
  - duplicate name → rejects.
  - invalid name (`API-1`) → rejects before any AWS call.
  - dbDestroy shared: DROP DATABASE/ROLE SQL + url param deleted + record deleted.
  - dbDestroy dedicated: DeleteStack + both params deleted.
  - dbAllowIp: uses injected fetch's IP, one setMasterIpRule per unique SG.
  - program registers `db`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify and commit**
```bash
git add src/commands/db.ts src/program.ts tests/db-commands.test.ts tests/program.test.ts
git commit -m "feat: keel db create/list/url/allow-ip/destroy (shared + dedicated)"
```

---

### Task 6: Deploy-time linking (`"db": "<name>"` → DATABASE_URL + firewall)

**Files:**
- Modify: `src/targets/aws.ts` (deployAws, registerAwsApp), `src/commands/new.ts` (optional `--db`/`--project` flags, threaded through)
- Test: `tests/aws-target.test.ts` (extend)

**Interfaces:**
- `registerAwsApp` includes `db`/`project` from cfg in the AppRecord when present.
- `deployAws` gains, **before** `putDeploy`/StartBuild (so the build's task-def secrets include it):
```ts
  let dbRec: DbRecord | undefined;
  if (cfg.db) {
    dbRec = await getDb(reg, cfg.db);
    if (!dbRec) throw new Error(`database "${cfg.db}" not found — create it with \`keel db create ${cfg.db}\``);
    const urlRes = await clients.ssm.send(new GetParameterCommand({ Name: `/keel/db/${cfg.db}/url`, WithDecryption: true }));
    await setEnvVar(reg, cfg.name, "DATABASE_URL", urlRes.Parameter.Value as string);
  }
```
  and, **after** `ensureAppStack` returns `{ url, taskSgId }` in the live branch:
```ts
  if (dbRec) await allowAppSg(clients.ec2, dbRec.dbSgId, appStack.taskSgId, cfg.name);
```
- `keel new` gains `--db <name>` and `--project <p>` options (no prompt when absent — these are optional); written into keel.json when provided.

- [ ] **Step 1: Failing tests** — extend `tests/aws-target.test.ts`:
  - deployAws with `cfg.db = "api"` and a fake `GetCommand` for `DB#api` returning a DbRecord: asserts (a) a `PutParameterCommand` for `/keel/web/env/DATABASE_URL` **before** `StartBuildCommand` (index compare), (b) an `AuthorizeSecurityGroupIngressCommand` naming the DB SG + app task SG after the app stack create.
  - deployAws with `cfg.db` set but no DB record → rejects with `keel db create` hint, and no build started.
  - deployAws without `cfg.db`: no PutParameter for DATABASE_URL, no SG authorize (existing tests keep passing).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify and commit**
```bash
git add src/targets/aws.ts src/commands/new.ts tests/aws-target.test.ts
git commit -m "feat: deploy-time db linking - DATABASE_URL injection + per-app firewall grant"
```

---

### Task 7: Docs + live verification (REQUIRES USER — real AWS, ~$13/mo while shared instance runs)

**Executed inline by the controller with the user present.**

- [ ] **Step 1:** Extend `sample-app` to prove the DB path: add `sample-app/package.json` (`{ "name": "hello", "private": true, "type": "module", "dependencies": { "pg": "^8" } }`), update `server.mjs` — when `DATABASE_URL` is set, run `SELECT 1` per request and append ` — db ok` (or ` — db error: <msg>`) to the response; update the Dockerfile to `COPY package.json server.mjs ./` + `RUN npm install --omit=dev`. Local target still works without a DB. Commit.
- [ ] **Step 2 (live):** `keel db create demo` — first run provisions `keel-db-shared` (~8 min). Verify: `psql "$(keel db url demo)" -c 'select 1'` from the laptop.
- [ ] **Step 3 (live):** set sample-app keel.json to aws target with `"db": "demo"`; `keel deploy`; `curl` the URL → `hello from keel — db ok` (proves DATABASE_URL injection + the app-SG firewall grant end-to-end).
- [ ] **Step 4 (live):** `keel db destroy demo --yes`; tear down `keel-db-shared` + the app + ingress per the user's cost preference; restore sample-app keel.json to local.
- [ ] **Step 5:** Update README status (Phase 2 done) + GUIDE (db commands table, a `keel db` section, updated architecture diagram note, cost table row: shared RDS ~$13/mo). Commit:
```bash
git commit -m "chore: verify phase 2 end-to-end (db create, app link, psql), update docs"
```

---

## Self-review

- **Spec coverage:** selectable resources ✔ (DB records independent of apps; optional keel.json field), shared/dedicated ✔ (one template, `DbName` condition), public+firewalled ✔ (SG shell in CFN, CLI-owned rules, `/32` + app SG only), per-app SGs ✔ (Task 1, prerequisite), DATABASE_URL injection ✔ (before build so task-def secrets carry it), allow-ip ✔, destroy ✔ (both modes + orphaned-shared-instance hint), pg dependency ✔ (injectable factory, hex passwords eliminate escaping), no ALB for db-only projects ✔ (dbstack never touches ingress).
- **Placeholder scan:** interfaces are exact; template prose specs mirror the B2 style used successfully for `infra/ingress.yaml` (implementer writes YAML per enumerated properties, reviewer + live run verify).
- **Type consistency:** `ensureAppStack` return-type change is propagated (Task 1 fixes deployAws + tests in the same commit); `DbRecord.dbSgId` written at create (Task 5) and consumed at link time (Task 6); `DB_NAME_RE` defined once in registry.ts and imported by config/pgadmin.
- **Known risks for live verification:** RDS public accessibility in a default VPC requires the VPC's DNS + internet-gateway defaults (present in default VPCs); `pg` TLS with `rejectUnauthorized: false` (documented ponytail); first shared create ~8 min.
