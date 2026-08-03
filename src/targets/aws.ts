import { StartBuildCommand } from "@aws-sdk/client-codebuild";
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFormationClient, DeleteStackCommand, waitUntilStackDeleteComplete } from "@aws-sdk/client-cloudformation";
import { DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AppConfig } from "../config.js";
import { makeClients, type AwsClients } from "../aws/clients.js";
import { readGlobalConfig, type GlobalConfig } from "../aws/globalconfig.js";
import { ensureIngress } from "../aws/ingress.js";
import { ensureAppStack } from "../aws/appstack.js";
import { recordResource, forgetResource } from "../aws/projects.js";
import {
  ensureWebhookSecret, getApp, getDb, getAuth, getDeploy, listApps, listDeploys, listEnvVars, newDeployId,
  putApp, putDeploy, setEnvVar, unsetEnvVar, type DbRecord, type RegistryDeps,
} from "../aws/registry.js";

export interface AwsIo {
  gcfg?: GlobalConfig;
  clients?: AwsClients;
  sleep?: (ms: number) => Promise<void>;
  /** Override the machine-level project registry path (tests). */
  projectsPath?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function awsDeps(io: AwsIo = {}) {
  const gcfg = io.gcfg ?? readGlobalConfig();
  if (!gcfg.controlPlane) throw new Error("control plane missing — run `keel setup` first");
  if (gcfg.profile && !process.env.AWS_PROFILE) process.env.AWS_PROFILE = gcfg.profile;
  const clients = io.clients ?? makeClients(gcfg.region);
  const reg: RegistryDeps = { ddb: clients.ddb, ssm: clients.ssm, table: gcfg.controlPlane.tableName };
  return { gcfg, clients, reg, cp: gcfg.controlPlane, sleep: io.sleep ?? defaultSleep };
}

export async function registerAwsApp(cfg: AppConfig, io: AwsIo = {}): Promise<void> {
  const { reg, cp } = awsDeps(io);
  if (!cfg.repo) throw new Error("aws apps need a github repo — set `repo` in keel.json");
  // albPort is also the ListenerRule priority (albPort-8000) in domain mode, so it must start >= 8001.
  const apps = await listApps(reg);
  const used = apps.map((a) => a.albPort).filter((p): p is number => typeof p === "number");
  const albPort = used.length ? Math.max(...used) + 1 : 8001;
  await putApp(reg, {
    name: cfg.name, repo: cfg.repo, branch: cfg.branch, port: cfg.port,
    ...(cfg.dir ? { dir: cfg.dir } : {}), cpu: 256, memory: 512,
    healthPath: cfg.healthPath, createdAt: new Date().toISOString(), albPort,
    ...(cfg.db ? { db: cfg.db } : {}), ...(cfg.project ? { project: cfg.project } : {}),
    ...(cfg.auth ? { auth: cfg.auth } : {}),
  });
  const secret = await ensureWebhookSecret(reg, cfg.name);
  const hookUrl = `${cp.webhookBase}/${cfg.name}`;
  const ownerRepo = cfg.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  console.log(`registered "${cfg.name}".`);
  console.log(`webhook URL:    ${hookUrl}`);
  console.log(`webhook secret: ${secret}`);
  console.log(`add it with:`);
  console.log(
    `  gh api repos/${ownerRepo}/hooks -f 'name=web' -F 'active=true' -f 'events[]=push' ` +
    `-f 'config[url]=${hookUrl}' -f 'config[content_type]=json' -f 'config[secret]=${secret}'`,
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
  const ingress = await ensureIngress(clients, gcfg);
  let dbRec: DbRecord | undefined;
  if (cfg.db) {
    dbRec = await getDb(reg, cfg.db);
    if (!dbRec) throw new Error(`database "${cfg.db}" not found — create it with \`keel db create ${cfg.db}\``);
    const urlRes = await clients.ssm.send(new GetParameterCommand({ Name: `/keel/db/${cfg.db}/url`, WithDecryption: true }));
    // RDS certs chain to Amazon's CA, which app images don't trust — `sslmode=require` now means
    // full verification in node-pg (and prisma's pg adapter), so injected as-is the app can't
    // connect ("self-signed certificate in certificate chain", live-caught deploying a real
    // Next.js/prisma app). Default: encrypt-without-verify, the same contract Heroku/Render use.
    // Opt-in full verification: an app that ships the RDS CA bundle in its image sets
    // dbSslRootCert to the bundle's path and gets sslmode=verify-full pointed at it (#32).
    const appDbUrl = (urlRes.Parameter!.Value as string).replace(
      /sslmode=require/,
      cfg.dbSslRootCert ? `sslmode=verify-full&sslrootcert=${cfg.dbSslRootCert}` : "sslmode=no-verify",
    );
    await setEnvVar(reg, cfg.name, "DATABASE_URL", appDbUrl);
  }
  if (cfg.auth) {
    const authRec = await getAuth(reg, cfg.auth);
    if (!authRec) throw new Error(`auth "${cfg.auth}" not found — create it with \`keel auth create ${cfg.auth} --db <db>\``);
    const jwtRes = await clients.ssm.send(new GetParameterCommand({ Name: `/keel/auth/${cfg.auth}/jwt-secret`, WithDecryption: true }));
    await setEnvVar(reg, cfg.name, "GOTRUE_URL", authRec.url);
    await setEnvVar(reg, cfg.name, "JWT_SECRET", jwtRes.Parameter!.Value as string);
  }
  const id = newDeployId();
  await putDeploy(reg, { app: app.name, id, status: "queued", updatedAt: new Date().toISOString() });
  const started = await clients.codebuild.send(new StartBuildCommand({
    projectName: cp.buildProject,
    environmentVariablesOverride: buildEnvOverrides(app, id),
  }));
  const buildId: string | undefined = started.build?.id;
  console.log(`build started (${buildId ?? "id unknown"}) — waiting…`);

  const MAX_POLLS = 240; // 240 * 5s = 20 min
  let last = "queued";
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(5000);
    const dep = await getDeploy(reg, app.name, id);
    const status = dep?.status ?? "queued";
    if (status !== last) {
      console.log(`status: ${status}`);
      last = status;
    }
    if (status === "live") {
      const appStack = await ensureAppStack(clients, gcfg, app, ingress, app.albPort ?? 8001, dbRec?.dbSgId);
      recordResource({
        kind: "app",
        name: app.name,
        project: cfg.project ?? app.name,
        region: gcfg.region,
        stack: `keel-app-${app.name}`,
        repoPath: process.cwd(),
        url: appStack.url,
        createdAt: new Date().toISOString(),
      }, io.projectsPath);
      console.log(`live: ${appStack.url}`);
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

export async function logsAws(
  cfg: AppConfig,
  io: AwsIo = {},
  opts: { follow?: boolean } = {},
): Promise<void> {
  const { clients, sleep } = awsDeps(io);
  let start = Date.now() - 3600_000; // last hour on first call
  const printBatch = async (): Promise<void> => {
    const from = start;            // fixed for this whole pagination pass
    let hi = start;                // high-water mark
    let nextToken: string | undefined;
    do {
      const res = await clients.logs.send(
        new FilterLogEventsCommand({
          logGroupName: "/keel/apps",
          logStreamNamePrefix: cfg.name,
          startTime: from,
          nextToken,
        }),
      );
      for (const e of res.events ?? []) {
        console.log(`${new Date(e.timestamp ?? 0).toISOString()}  ${(e.message ?? "").trimEnd()}`);
        if (e.timestamp && e.timestamp + 1 > hi) hi = e.timestamp + 1;
      }
      nextToken = res.nextToken;
    } while (nextToken);
    start = hi;                    // advance only after the full pass
  };
  await printBatch();
  while (opts.follow) {
    await sleep(3000);
    await printBatch();
  }
}

export async function destroyAws(cfg: AppConfig, io: AwsIo = {}): Promise<void> {
  const { reg, clients, cp } = awsDeps(io);
  const app = await getApp(reg, cfg.name);
  if (!app) throw new Error(`app "${cfg.name}" is not registered — nothing to destroy`);

  // 1. Delete the per-app CloudFormation stack (service, target group, routing).
  const stackName = `keel-app-${cfg.name}`;
  await clients.cfn.send(new DeleteStackCommand({ StackName: stackName }));
  // maxWaitTime: 900 (15m) — delete is faster than create/update, which use 1800 (30m).
  await waitUntilStackDeleteComplete({ client: clients.cfn as CloudFormationClient, maxWaitTime: 900 }, { StackName: stackName });

  // 2. Delete all DynamoDB records for the app (META + every DEPLOY#...).
  // ponytail: single Query page (up to 1MB) — fine for an app's deploy history, paginate if that ever fills up.
  const items = await clients.ddb.send(new QueryCommand({
    TableName: cp.tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `APP#${cfg.name}` },
  }));
  for (const it of items.Items ?? []) {
    await clients.ddb.send(new DeleteCommand({ TableName: cp.tableName, Key: { PK: it.PK, SK: it.SK } }));
  }

  // 3. Delete the app's SSM params (webhook secret + env vars). Paginate — GetParametersByPath
  // pages at 10 by default, and apps commonly have more than 10 params (see commit 73703d1).
  let recordCount = 0;
  let nextToken: string | undefined;
  do {
    const params = await clients.ssm.send(
      new GetParametersByPathCommand({ Path: `/keel/${cfg.name}`, Recursive: true, NextToken: nextToken }),
    );
    for (const p of params.Parameters ?? []) {
      if (p.Name) {
        await clients.ssm.send(new DeleteParameterCommand({ Name: p.Name }));
        recordCount++;
      }
    }
    nextToken = params.NextToken;
  } while (nextToken);

  forgetResource("app", cfg.name, io.projectsPath);
  console.log(`destroyed ${cfg.name}: deleted stack ${stackName}, ${(items.Items ?? []).length} records, ${recordCount} secrets`);
  console.log(`(shared ingress stack and ECR images left intact)`);
}
