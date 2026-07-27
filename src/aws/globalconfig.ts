import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ControlPlane {
  stackName: string;
  tableName: string;
  clusterName: string;
  ecrRepoUri: string;
  buildProject: string;
  webhookBase: string;
  taskExecRoleArn: string;
  logGroup: string;
  vpcId: string;
  subnetIds: string[];
}

export interface GlobalConfig {
  region: string;
  profile?: string;
  baseDomain?: string;
  githubTokenStored?: boolean;
  ingress: "port" | "domain";
  hostedZoneId?: string;
  controlPlane?: ControlPlane;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".bareboat", "config.json");

export function readGlobalConfig(path = GLOBAL_CONFIG_PATH): GlobalConfig {
  if (!existsSync(path)) {
    throw new Error("bareboat is not set up on this machine — run `bareboat setup` first");
  }
  return JSON.parse(readFileSync(path, "utf8")) as GlobalConfig;
}

export function writeGlobalConfig(cfg: GlobalConfig, path = GLOBAL_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
