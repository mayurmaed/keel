import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand } from "../src/commands/setup";

function fakeClients() {
  const calls: Array<{ client: string; cmd: string; input: any }> = [];
  let stackExists = false;
  const mk = (client: string, answers: Record<string, unknown>) => ({
    send: async (c: any) => {
      calls.push({ client, cmd: c.constructor.name, input: c.input });
      // Track stack creation/update for proper state transitions
      if (client === "cfn") {
        if (c.constructor.name === "CreateStackCommand" || c.constructor.name === "UpdateStackCommand") {
          stackExists = true;
        }
        // Return appropriate status based on operation
        if (c.constructor.name === "DescribeStacksCommand") {
          if (!stackExists) {
            throw new Error("Stack does not exist");
          }
          return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: answers.Outputs }] };
        }
      }
      return answers[c.constructor.name] ?? {};
    },
  });
  const outputs = [
    { OutputKey: "TableName", OutputValue: "keel" },
    { OutputKey: "ClusterName", OutputValue: "keel" },
    { OutputKey: "EcrRepoUri", OutputValue: "1.dkr.ecr.x.amazonaws.com/keel-apps" },
    { OutputKey: "BuildProject", OutputValue: "keel-build" },
    { OutputKey: "WebhookBase", OutputValue: "https://api.example.com/hook" },
    { OutputKey: "TaskExecRoleArn", OutputValue: "arn:aws:iam::1:role/keel-task-exec" },
    { OutputKey: "LogGroup", OutputValue: "/keel/apps" },
  ];
  return {
    calls,
    clients: {
      sts: mk("sts", { GetCallerIdentityCommand: { Account: "111122223333" } }),
      ec2: mk("ec2", {
        DescribeVpcsCommand: { Vpcs: [{ VpcId: "vpc-123" }] },
        DescribeSubnetsCommand: { Subnets: [{ SubnetId: "subnet-a" }, { SubnetId: "subnet-b" }] },
      }),
      ssm: mk("ssm", {}),
      cfn: mk("cfn", { Outputs: outputs }),
    } as any,
  };
}

describe("setupCommand", () => {
  it("deploys the stack with the webhook code and writes global config", async () => {
    const { calls, clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand({ region: "ap-south-1", yes: true }, { clients, configPath });

    const create = calls.find((c) => ["CreateStackCommand", "UpdateStackCommand"].includes(c.cmd));
    expect(create).toBeDefined();
    const webhookParam = create!.input.Parameters.find((p: any) => p.ParameterKey === "WebhookCode");
    expect(webhookParam.ParameterValue).toContain("makeHandler");

    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.region).toBe("ap-south-1");
    expect(cfg.controlPlane.tableName).toBe("keel");
    expect(cfg.controlPlane.vpcId).toBe("vpc-123");
    expect(cfg.controlPlane.subnetIds).toEqual(["subnet-a", "subnet-b"]);
    expect(cfg.controlPlane.webhookBase).toBe("https://api.example.com/hook");
  });

  it("stores a github token in SSM when provided", async () => {
    const { calls, clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    await setupCommand({ region: "ap-south-1", githubToken: "ghp_x", yes: true }, { clients, configPath });
    const put = calls.find((c) => c.client === "ssm" && c.cmd === "PutParameterCommand")!;
    expect(put.input).toMatchObject({ Name: "/keel/github-token", Type: "SecureString", Overwrite: true });
  });

  it("stores the profile in config and sets AWS_PROFILE", async () => {
    const { clients } = fakeClients();
    const configPath = join(mkdtempSync(join(tmpdir(), "keel-test-")), "config.json");
    const prior = process.env.AWS_PROFILE;
    try {
      delete process.env.AWS_PROFILE;
      await setupCommand({ region: "ap-south-1", profile: "keel", yes: true }, { clients, configPath });
      expect(process.env.AWS_PROFILE).toBe("keel");
      expect(JSON.parse(readFileSync(configPath, "utf8")).profile).toBe("keel");
    } finally {
      if (prior === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = prior;
    }
  });

  it("fails with an aws-configure hint when credentials are absent", async () => {
    const { clients } = fakeClients();
    (clients as any).sts = { send: async () => { throw new Error("Could not load credentials"); } };
    await expect(
      setupCommand({ region: "ap-south-1", yes: true }, { clients, configPath: "/dev/null" }),
    ).rejects.toThrow(/aws configure/);
  });
});
