import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import type { IngressInfo } from "./ingress.js";
import { deployStack, projectTags } from "./stack.js";

export async function ensureJwtSecret(ssm: { send(c: any): Promise<any> }, name: string): Promise<string> {
  const paramName = `/bareboat/auth/${name}/jwt-secret`;
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
  if (!gcfg.controlPlane) throw new Error("run `bareboat setup` first");
  const cp = gcfg.controlPlane;
  const template = readFileSync(new URL("../../infra/auth.yaml", import.meta.url), "utf8");
  const out = await deployStack(clients.cfn, `bareboat-auth-${auth.name}`, template, {
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
  }, { tags: projectTags(auth.project) });
  return { url: out.Url, taskSgId: out.TaskSgId };
}
