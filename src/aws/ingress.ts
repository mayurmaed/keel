import { readFileSync } from "node:fs";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import { deployStack, SHARED_TAGS } from "./stack.js";

export interface IngressInfo {
  albDns: string;
  albArn: string;
  albSgId: string;
  httpsListenerArn?: string;
}

const INGRESS_STACK = "bareboat-ingress";

export async function ensureIngress(clients: Pick<AwsClients, "cfn">, gcfg: GlobalConfig): Promise<IngressInfo> {
  if (!gcfg.controlPlane) throw new Error("run `bareboat setup` first");
  const template = readFileSync(new URL("../../infra/ingress.yaml", import.meta.url), "utf8");
  const params: Record<string, string> = {
    Mode: gcfg.ingress,
    VpcId: gcfg.controlPlane.vpcId,
    Subnets: gcfg.controlPlane.subnetIds.join(","),
    BaseDomain: gcfg.baseDomain ?? "",
    HostedZoneId: gcfg.hostedZoneId ?? "",
  };
  const out = await deployStack(clients.cfn, INGRESS_STACK, template, params, { tags: SHARED_TAGS });
  return {
    albDns: out.AlbDns,
    albArn: out.AlbArn,
    albSgId: out.AlbSgId,
    ...(out.HttpsListenerArn ? { httpsListenerArn: out.HttpsListenerArn } : {}),
  };
}
