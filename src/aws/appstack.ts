import { readFileSync } from "node:fs";
import type { AwsClients } from "./clients.js";
import type { GlobalConfig } from "./globalconfig.js";
import type { AppRecord } from "./registry.js";
import type { IngressInfo } from "./ingress.js";
import { deployStack } from "./stack.js";

export async function ensureAppStack(
  clients: Pick<AwsClients, "cfn">,
  gcfg: GlobalConfig,
  app: AppRecord,
  ingress: IngressInfo,
  albPort: number,
): Promise<{ url: string; taskSgId: string }> {
  if (!gcfg.controlPlane) throw new Error("run `keel setup` first");
  const template = readFileSync(new URL("../../infra/app.yaml", import.meta.url), "utf8");
  const params: Record<string, string> = {
    AppName: app.name,
    Cluster: gcfg.controlPlane.clusterName,
    VpcId: gcfg.controlPlane.vpcId,
    Subnets: gcfg.controlPlane.subnetIds.join(","),
    AlbSgId: ingress.albSgId,
    AlbArn: ingress.albArn,
    AlbDns: ingress.albDns,
    Mode: gcfg.ingress,
    ContainerPort: String(app.port),
    HealthPath: app.healthPath,
    AlbPort: String(albPort),
    // albPort must start at 8001 - ListenerRule Priority (albPort-8000) must be >= 1.
    Priority: String(albPort - 8000),
    BaseDomain: gcfg.baseDomain ?? "",
    HttpsListenerArn: ingress.httpsListenerArn ?? "",
    HostedZoneId: gcfg.hostedZoneId ?? "",
  };
  const out = await deployStack(clients.cfn, `keel-app-${app.name}`, template, params);
  return { url: out.Url, taskSgId: out.TaskSgId };
}
