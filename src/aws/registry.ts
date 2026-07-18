import { randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { DB_NAME_RE } from "../config.js";

export { DB_NAME_RE };

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
  albPort?: number;
  db?: string;
  project?: string;
}

export interface DeployRecord {
  app: string;
  id: string;
  status: "queued" | "building" | "live" | "failed";
  commit?: string;
  buildId?: string;
  updatedAt: string;
}

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
    FilterExpression: "SK = :meta AND begins_with(PK, :app)",
    ExpressionAttributeValues: { ":meta": "META", ":app": "APP#" },
  }));
  return (res.Items ?? []).map(({ PK, SK, ...app }: any) => app as AppRecord);
}

export async function putDb(d: RegistryDeps, db: DbRecord): Promise<void> {
  await d.ddb.send(new PutCommand({ TableName: d.table, Item: { PK: `DB#${db.name}`, SK: "META", ...db } }));
}

export async function getDb(d: RegistryDeps, name: string): Promise<DbRecord | undefined> {
  const res = await d.ddb.send(new GetCommand({ TableName: d.table, Key: { PK: `DB#${name}`, SK: "META" } }));
  if (!res.Item) return undefined;
  const { PK, SK, ...db } = res.Item;
  return db as DbRecord;
}

export async function listDbs(d: RegistryDeps): Promise<DbRecord[]> {
  // ponytail: Scan is fine — the table holds tens of items, not millions
  const res = await d.ddb.send(new ScanCommand({
    TableName: d.table,
    FilterExpression: "SK = :meta AND begins_with(PK, :db)",
    ExpressionAttributeValues: { ":meta": "META", ":db": "DB#" },
  }));
  return (res.Items ?? []).map(({ PK, SK, ...db }: any) => db as DbRecord);
}

export async function deleteDbRecord(d: RegistryDeps, name: string): Promise<void> {
  await d.ddb.send(new DeleteCommand({ TableName: d.table, Key: { PK: `DB#${name}`, SK: "META" } }));
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
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const res = await d.ssm.send(
      new GetParametersByPathCommand({ Path: envPath(app), WithDecryption: true, NextToken }),
    );
    for (const p of res.Parameters ?? []) out[String(p.Name).split("/").pop()!] = p.Value as string;
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}
