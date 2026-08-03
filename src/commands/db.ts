import { randomBytes } from "node:crypto";
import { PutParameterCommand, GetParameterCommand, DeleteParameterCommand } from "@aws-sdk/client-ssm";
import { CloudFormationClient, DeleteStackCommand, waitUntilStackDeleteComplete } from "@aws-sdk/client-cloudformation";
import { DB_NAME_RE } from "../config.js";
import { ensureDbInstance, getMyIp, setMasterIpRule } from "../aws/dbstack.js";
import { realPg, createLogicalDb, dropLogicalDb, type PgFactory } from "../aws/pgadmin.js";
import { putDb, getDb, listDbs, deleteDbRecord, type DbRecord } from "../aws/registry.js";
import { recordResource, forgetResource } from "../aws/projects.js";
import { awsDeps, type AwsIo } from "../targets/aws.js";

export type DbIo = AwsIo & { pg?: PgFactory; fetchImpl?: typeof fetch };

function notFound(name: string): Error {
  return new Error(`database "${name}" not found — create it with \`bareboat db create ${name}\``);
}

export async function dbCreate(
  name: string,
  opts: { isolation?: string; project?: string; backupDays?: string } = {},
  io: DbIo = {},
): Promise<void> {
  if (!DB_NAME_RE.test(name)) {
    throw new Error(`invalid database name "${name}" — lowercase letters, digits, underscores only, starting with a letter`);
  }
  const isolation = opts.isolation ?? "shared";
  if (isolation !== "shared" && isolation !== "dedicated") {
    throw new Error(`--isolation must be "shared" or "dedicated", got "${isolation}"`);
  }

  if (isolation === "dedicated") {
    if (name.includes("_")) {
      throw new Error(`dedicated databases can't contain underscores (the name becomes the RDS instance id "bareboat-db-${name}") — use hyphens-free lowercase letters/digits, or use --isolation shared`);
    }
    // 63 (RDS instance id cap) minus the 12-char "bareboat-db-" prefix.
    if (name.length > 51) {
      throw new Error(`dedicated database names are limited to 51 characters (RDS instance id "bareboat-db-<name>" caps at 63)`);
    }
    if (name === "postgres") {
      throw new Error(`"postgres" is reserved by RDS — pick another name`);
    }
  }

  const { gcfg, clients, reg } = awsDeps(io);
  if (await getDb(reg, name)) throw new Error(`database "${name}" already exists`);
  const pg = io.pg ?? realPg;
  const fetchImpl = io.fetchImpl ?? fetch;

  let host: string, dbSgId: string, masterPassword: string, url: string, dbUser: string, stack: string;
  if (isolation === "shared") {
    console.log("first shared database provisions the instance — takes ~8 minutes");
    stack = "bareboat-db-shared";
    ({ host, dbSgId, masterPassword } = await ensureDbInstance(clients, gcfg, {
      stackName: stack, instanceId: stack, masterPasswordSsm: "/bareboat/db-shared/master",
      ...(opts.backupDays ? { backupDays: Number(opts.backupDays) } : {}),
    }));
    await setMasterIpRule(clients.ec2, dbSgId, await getMyIp(fetchImpl));
    const adminUrl = `postgres://bareboatadmin:${masterPassword}@${host}:5432/postgres?sslmode=require`;
    const appPw = randomBytes(24).toString("hex");
    await createLogicalDb(pg, adminUrl, name, appPw);
    url = `postgres://${name}:${appPw}@${host}:5432/${name}?sslmode=require`;
    dbUser = name;
  } else {
    stack = `bareboat-db-${name}`;
    ({ host, dbSgId, masterPassword } = await ensureDbInstance(clients, gcfg, {
      stackName: stack, instanceId: stack, masterPasswordSsm: `/bareboat/db/${name}/master`, dbName: name, project: opts.project ?? name,
      ...(opts.backupDays ? { backupDays: Number(opts.backupDays) } : {}),
    }));
    await setMasterIpRule(clients.ec2, dbSgId, await getMyIp(fetchImpl));
    url = `postgres://bareboatadmin:${masterPassword}@${host}:5432/${name}?sslmode=require`;
    dbUser = "bareboatadmin";
  }

  await clients.ssm.send(new PutParameterCommand({
    Name: `/bareboat/db/${name}/url`, Value: url, Type: "SecureString", Overwrite: true,
  }));
  await putDb(reg, {
    name, project: opts.project ?? name, isolation, access: "public", engine: "postgres",
    host, port: 5432, dbName: name, dbUser, stack, dbSgId, createdAt: new Date().toISOString(),
  });
  recordResource({
    kind: "db", name, project: opts.project ?? name, region: gcfg.region,
    stack, url: `${host}:5432`, createdAt: new Date().toISOString(),
  }, io.projectsPath);
  console.log(url);
  console.log("your current IP is allowed. if it changes: bareboat db allow-ip");
}

export async function dbList(io: DbIo = {}): Promise<void> {
  const { reg } = awsDeps(io);
  const dbs = await listDbs(reg);
  if (!dbs.length) {
    console.log("no databases — create one with `bareboat db create <name>`");
    return;
  }
  for (const d of dbs) console.log(`${d.name}  ${d.isolation}  ${d.project}  ${d.host}`);
}

export async function dbUrl(name: string, io: DbIo = {}): Promise<void> {
  const { clients } = awsDeps(io);
  try {
    const res = await clients.ssm.send(new GetParameterCommand({ Name: `/bareboat/db/${name}/url`, WithDecryption: true }));
    console.log(res.Parameter!.Value as string);
  } catch (e: any) {
    if (e?.name !== "ParameterNotFound") throw e;
    throw notFound(name);
  }
}

export async function dbAllowIp(opts: { db?: string; ip?: string } = {}, io: DbIo = {}): Promise<void> {
  const { clients, reg } = awsDeps(io);
  let targets: DbRecord[];
  if (opts.db) {
    const rec = await getDb(reg, opts.db);
    if (!rec) throw notFound(opts.db);
    targets = [rec];
  } else {
    targets = await listDbs(reg);
    if (!targets.length) {
      console.log("no databases");
      return;
    }
  }
  const ip = opts.ip ?? await getMyIp(io.fetchImpl ?? fetch);
  const sgIds = [...new Set(targets.map((t) => t.dbSgId))];
  for (const sgId of sgIds) await setMasterIpRule(clients.ec2, sgId, ip);
  console.log(`allowed ${ip} on ${sgIds.length} security group(s)`);
}

export async function dbDestroy(name: string, io: DbIo = {}): Promise<void> {
  const { clients, reg } = awsDeps(io);
  const rec = await getDb(reg, name);
  if (!rec) throw notFound(name);

  if (rec.isolation === "shared") {
    const res = await clients.ssm.send(new GetParameterCommand({ Name: "/bareboat/db-shared/master", WithDecryption: true }));
    const adminUrl = `postgres://bareboatadmin:${res.Parameter!.Value}@${rec.host}:5432/postgres?sslmode=require`;
    await dropLogicalDb(io.pg ?? realPg, adminUrl, name);
  } else {
    const stackName = `bareboat-db-${name}`;
    await clients.cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete({ client: clients.cfn as CloudFormationClient, maxWaitTime: 900 }, { StackName: stackName });
    await clients.ssm.send(new DeleteParameterCommand({ Name: `/bareboat/db/${name}/master` }));
  }

  try {
    await clients.ssm.send(new DeleteParameterCommand({ Name: `/bareboat/db/${name}/url` }));
  } catch (e: any) {
    if (e?.name !== "ParameterNotFound") throw e;
  }
  await deleteDbRecord(reg, name);
  forgetResource("db", name, io.projectsPath);
  console.log(`destroyed database "${name}"`);

  if (rec.isolation === "shared") {
    const remaining = await listDbs(reg);
    if (remaining.every((d) => d.isolation !== "shared")) {
      console.log(
        "shared instance bareboat-db-shared is still running (~$13/mo) — remove it with: " +
        "aws cloudformation delete-stack --stack-name bareboat-db-shared",
      );
    }
  }
}
