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
  if (gcfg.profile && !process.env.AWS_PROFILE) process.env.AWS_PROFILE = gcfg.profile;
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
