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
