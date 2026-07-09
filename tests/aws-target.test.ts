import { describe, it, expect } from "vitest";
import { deployAws, registerAwsApp } from "../src/targets/aws";
import type { AppConfig } from "../src/config";

const cfg: AppConfig = {
  name: "web", branch: "main", port: 3000, target: "aws",
  env: {}, healthPath: "/", repo: "https://github.com/me/web",
};

const gcfg = {
  region: "ap-south-1",
  controlPlane: {
    stackName: "keel-control-plane", tableName: "keel", clusterName: "keel",
    ecrRepoUri: "1.dkr.ecr.x/keel-apps", buildProject: "keel-build",
    webhookBase: "https://api.example.com/hook",
    taskExecRoleArn: "arn:x", logGroup: "/keel/apps", vpcId: "vpc-1", subnetIds: ["s-1"],
  },
} as any;

function fakeIo(deployStatuses: string[]) {
  const calls: Array<{ cmd: string; input: any }> = [];
  let statusIdx = 0;
  const send = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetParameterCommand") return { Parameter: { Value: "secret" } };
    if (cmd === "GetCommand") {
      if (String(c.input.Key.SK) === "META") return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t" } };
      const status = deployStatuses[Math.min(statusIdx++, deployStatuses.length - 1)];
      return { Item: { PK: "APP#web", SK: c.input.Key.SK, status, updatedAt: "t" } };
    }
    if (cmd === "StartBuildCommand") return { build: { id: "keel-build:abc123" } };
    return {};
  };
  const clients = { ddb: { send }, ssm: { send }, codebuild: { send } } as any;
  return { calls, io: { gcfg, clients, sleep: async () => {} } };
}

describe("deployAws", () => {
  it("queues a deploy, starts the build with env overrides, and resolves on live", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    await deployAws(cfg, io);
    const start = calls.find((c) => c.cmd === "StartBuildCommand")!;
    const envs = Object.fromEntries(start.input.environmentVariablesOverride.map((e: any) => [e.name, e.value]));
    expect(start.input.projectName).toBe("keel-build");
    expect(envs.APP).toBe("web");
    expect(envs.PORT).toBe("3000");
    expect(envs.DEPLOY_ID).toMatch(/^\d{8}T\d{6}Z$/);
    const queued = calls.find((c) => c.cmd === "PutCommand" && String(c.input.Item.SK).startsWith("DEPLOY#"))!;
    expect(queued.input.Item.status).toBe("queued");
  });

  it("throws with the codebuild console hint when the build fails", async () => {
    const { io } = fakeIo(["building", "failed"]);
    await expect(deployAws(cfg, io)).rejects.toThrow(/codebuild/i);
  });
});

describe("registerAwsApp", () => {
  it("registers the app and prints the webhook url + gh one-liner", async () => {
    const { calls, io } = fakeIo([]);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await registerAwsApp(cfg, io);
    } finally {
      console.log = orig;
    }
    expect(calls.some((c) => c.cmd === "PutCommand" && c.input.Item.SK === "META")).toBe(true);
    const text = logs.join("\n");
    expect(text).toContain("https://api.example.com/hook/web");
    expect(text).toContain("gh api repos/me/web/hooks");
  });
});
