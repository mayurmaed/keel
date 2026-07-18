import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import { deployStack } from "./stack.js";

export interface DbInstanceInfo {
  host: string;
  dbSgId: string;
  masterPassword: string;
}

export async function ensureDbInstance(
  clients: Pick<AwsClients, "cfn" | "ssm">,
  gcfg: GlobalConfig,
  opts: { stackName: string; instanceId: string; masterPasswordSsm: string; dbName?: string; backupDays?: number },
): Promise<DbInstanceInfo> {
  if (!gcfg.controlPlane) throw new Error("run `keel setup` first");

  let masterPassword: string;
  try {
    const res = await clients.ssm.send(new GetParameterCommand({ Name: opts.masterPasswordSsm, WithDecryption: true }));
    masterPassword = res.Parameter!.Value as string;
  } catch (e: any) {
    if (e?.name !== "ParameterNotFound") throw e;
    masterPassword = randomBytes(24).toString("hex");
    await clients.ssm.send(new PutParameterCommand({ Name: opts.masterPasswordSsm, Value: masterPassword, Type: "SecureString" }));
  }

  const template = readFileSync(new URL("../../infra/db.yaml", import.meta.url), "utf8");
  const out = await deployStack(clients.cfn, opts.stackName, template, {
    InstanceId: opts.instanceId,
    MasterPassword: masterPassword,
    VpcId: gcfg.controlPlane.vpcId,
    Subnets: gcfg.controlPlane.subnetIds.join(","),
    DbName: opts.dbName ?? "",
    BackupDays: String(opts.backupDays ?? 7),
  });

  return { host: out.Endpoint, dbSgId: out.DbSgId, masterPassword };
}

export async function getMyIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://checkip.amazonaws.com");
  const ip = (await res.text()).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error(`could not determine your public IP (got "${ip}") — pass one explicitly: keel db allow-ip <ip>`);
  }
  return ip;
}

type Ec2 = { send(c: any): Promise<any> };

export async function setMasterIpRule(ec2: Ec2, sgId: string, ip: string): Promise<void> {
  const rules = await ec2.send(new DescribeSecurityGroupRulesCommand({
    Filters: [{ Name: "group-id", Values: [sgId] }],
  }));
  const stale = (rules.SecurityGroupRules ?? [])
    .filter((r: any) => !r.IsEgress && r.Description === "keel:master")
    .map((r: any) => r.SecurityGroupRuleId);
  if (stale.length) {
    await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: sgId, SecurityGroupRuleIds: stale }));
  }
  try {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: `${ip}/32`, Description: "keel:master" }] }],
    }));
  } catch (e: any) {
    if (e?.name !== "InvalidPermission.Duplicate") throw e;
  }
}
