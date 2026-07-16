import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureAppStack } from "../src/aws/appstack";

function fakeClients(outputs: Record<string, string>) {
  const seenParams: any[] = [];
  const cfn = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      if (cmd === "CreateStackCommand") seenParams.push(c.input.Parameters);
      if (cmd === "DescribeStacksCommand") {
        if (!seenParams.length) throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    },
  };
  return { seenParams, clients: { cfn } as any };
}

const app = { name: "myapp", repo: "r", branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/health", createdAt: "now" } as any;

const ingress = { albDns: "keel-alb-1.elb.amazonaws.com", albArn: "arn:alb", albSgId: "sg-alb", taskSgId: "sg-task" };

describe("ensureAppStack — port mode", () => {
  const gcfg = { region: "ap-south-1", ingress: "port", controlPlane: { clusterName: "keel-cluster", vpcId: "vpc-1", subnetIds: ["s-1", "s-2"] } } as any;

  it("deploys the app stack and returns the port-mode URL", async () => {
    const { seenParams, clients } = fakeClients({ Url: "http://keel-alb-1.elb.amazonaws.com:8001", TaskSgId: "sg-app" });
    const result = await ensureAppStack(clients, gcfg, app, ingress, 8001);
    expect(result).toEqual({ url: "http://keel-alb-1.elb.amazonaws.com:8001", taskSgId: "sg-app" });

    const params = Object.fromEntries(seenParams[0].map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.AppName).toBe("myapp");
    expect(params.Mode).toBe("port");
    expect(params.AlbPort).toBe("8001");
    expect(params.Cluster).toBe("keel-cluster");
    expect(params.Subnets).toBe("s-1,s-2");
    expect(params.AlbSgId).toBe("sg-alb");
    expect(params.TaskSgId).toBeUndefined();
    expect(params.DbSgId).toBe("");
    expect(params.ContainerPort).toBe("3000");
    expect(params.HealthPath).toBe("/health");
  });

  it("passes the linked database security group to the stack", async () => {
    const { seenParams, clients } = fakeClients({ Url: "http://keel-alb-1.elb.amazonaws.com:8001", TaskSgId: "sg-app" });
    await ensureAppStack(clients, gcfg, app, ingress, 8001, "sg-db");

    const params = Object.fromEntries(seenParams[0].map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.DbSgId).toBe("sg-db");
  });
});

describe("ensureAppStack — domain mode", () => {
  const gcfg = {
    region: "ap-south-1",
    ingress: "domain",
    baseDomain: "example.com",
    hostedZoneId: "Z123",
    controlPlane: { clusterName: "keel-cluster", vpcId: "vpc-1", subnetIds: ["s-1", "s-2"] },
  } as any;
  const domainIngress = { ...ingress, httpsListenerArn: "arn:listener:https" };

  it("deploys with domain params and returns the domain URL", async () => {
    const { seenParams, clients } = fakeClients({ Url: "https://myapp.example.com", TaskSgId: "sg-app" });
    const result = await ensureAppStack(clients, gcfg, app, domainIngress, 8002);
    expect(result).toEqual({ url: "https://myapp.example.com", taskSgId: "sg-app" });

    const params = Object.fromEntries(seenParams[0].map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.BaseDomain).toBe("example.com");
    expect(params.HttpsListenerArn).toBe("arn:listener:https");
    expect(params.HostedZoneId).toBe("Z123");
    expect(params.Priority).toBe("2");
    expect(params.Mode).toBe("domain");
  });
});

describe("app template", () => {
  const tpl = readFileSync("infra/app.yaml", "utf8");
  it("declares target group, fargate service, and host-header routing", () => {
    for (const k of ["TargetGroup", "AWS::ECS::Service", "host-header", "TargetType", "AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupIngress", "HasDb"]) expect(tpl).toContain(k);
  });
});
