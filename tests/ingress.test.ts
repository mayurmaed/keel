import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureIngress } from "../src/aws/ingress";

function fakeClients(outputs: Record<string, string>) {
  const calls: string[] = [];
  const cfn = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push(cmd);
      if (cmd === "DescribeStacksCommand") {
        if (!calls.includes("CreateStackCommand")) {
          throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
        }
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    },
  };
  return { calls, clients: { cfn } as any };
}

const gcfg = { region: "ap-south-1", ingress: "port", controlPlane: { vpcId: "vpc-1", subnetIds: ["s-1", "s-2"] } } as any;

describe("ensureIngress", () => {
  it("creates the ingress stack and returns outputs", async () => {
    const { calls, clients } = fakeClients({ AlbDns: "keel-alb-123.elb.amazonaws.com", AlbArn: "arn:alb", AlbSgId: "sg-alb" });
    const info = await ensureIngress(clients, gcfg);
    expect(calls).toContain("CreateStackCommand");
    expect(info.albDns).toBe("keel-alb-123.elb.amazonaws.com");
  });

  it("passes Mode=port and the subnets as parameters", async () => {
    const seen: any[] = [];
    const clients = { cfn: { send: async (c: any) => {
      if (c.constructor.name === "CreateStackCommand") seen.push(c.input.Parameters);
      if (c.constructor.name === "DescribeStacksCommand") {
        if (!seen.length) throw Object.assign(new Error("no"), { name: "ValidationError" });
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [{ OutputKey: "AlbDns", OutputValue: "d" }, { OutputKey: "AlbArn", OutputValue: "a" }, { OutputKey: "AlbSgId", OutputValue: "s" }] }] };
      }
      return {};
    } } } as any;
    await ensureIngress(clients, gcfg);
    const params = Object.fromEntries(seen[0].map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.Mode).toBe("port");
    expect(params.Subnets).toBe("s-1,s-2");
  });
});

describe("ingress template", () => {
  const tpl = readFileSync("infra/ingress.yaml", "utf8");
  it("declares mode-conditional ALB, SGs, and outputs", () => {
    for (const k of ["Mode", "keel-alb", "AlbDns", "AlbSgId"]) expect(tpl).toContain(k);
  });
  it("does not declare a shared task security group", () => {
    expect(tpl).not.toContain("TaskSg:");
  });
});
