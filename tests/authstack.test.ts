import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureJwtSecret, ensureAuthStack } from "../src/aws/authstack";

function fakeCfn(outputs: Record<string, string>) {
  const calls: any[] = [];
  const cfn = { send: async (c: any) => {
    const cmd = c.constructor.name; calls.push({ cmd, input: c.input });
    if (cmd === "DescribeStacksCommand") {
      if (!calls.some((k) => k.cmd === "CreateStackCommand"))
        throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    }
    return {};
  } };
  return { calls, cfn };
}

const gcfg = {
  region: "ap-south-1", ingress: "port",
  controlPlane: { clusterName: "bareboat", vpcId: "vpc-1", subnetIds: ["s-1", "s-2"], taskExecRoleArn: "arn:role", logGroup: "/bareboat/apps" },
} as any;
const ingress = { albDns: "alb.example", albArn: "arn:alb", albSgId: "sg-alb" } as any;

describe("ensureJwtSecret", () => {
  it("generates + stores a 64-hex secret when missing", async () => {
    const calls: any[] = [];
    const ssm = { send: async (c: any) => {
      const cmd = c.constructor.name; calls.push({ cmd, input: c.input });
      if (cmd === "GetParameterCommand") throw Object.assign(new Error("x"), { name: "ParameterNotFound" });
      return {};
    } };
    const secret = await ensureJwtSecret(ssm, "appauth");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const put = calls.find((k) => k.cmd === "PutParameterCommand");
    expect(put.input).toMatchObject({ Name: "/bareboat/auth/appauth/jwt-secret", Type: "SecureString" });
  });

  it("returns the existing secret", async () => {
    const ssm = { send: async (c: any) =>
      c.constructor.name === "GetParameterCommand" ? { Parameter: { Value: "existing" } } : {} };
    expect(await ensureJwtSecret(ssm, "appauth")).toBe("existing");
  });
});

describe("ensureAuthStack", () => {
  it("creates bareboat-auth-<name> and returns url + taskSgId", async () => {
    const { calls, cfn } = fakeCfn({ Url: "http://alb.example:8100", TaskSgId: "sg-auth" });
    const out = await ensureAuthStack({ cfn } as any, gcfg, { name: "appauth", project: "appauth" }, ingress, 8100, "sg-db", "/bareboat/db/appdb/url", "/bareboat/auth/appauth/jwt-secret");
    expect(out).toEqual({ url: "http://alb.example:8100", taskSgId: "sg-auth" });
    const create = calls.find((k) => k.cmd === "CreateStackCommand");
    const params = Object.fromEntries(create.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.AuthName).toBe("appauth");
    expect(params.DbSgId).toBe("sg-db");
    expect(params.DbUrlParam).toBe("/bareboat/db/appdb/url");
    expect(params.JwtSecretParam).toBe("/bareboat/auth/appauth/jwt-secret");
    expect(params.Project).toBe("appauth");
  });
});

describe("auth template", () => {
  const tpl = readFileSync("infra/auth.yaml", "utf8");
  it("declares a gotrue service, db ingress, target group, and outputs", () => {
    for (const k of ["supabase/auth", "9999", "/health", "DbIngress", "AWS::ECS::Service", "GOTRUE_JWT_SECRET", "GOTRUE_DB_DATABASE_URL", "bareboat:project", "TaskSgId", "Url"])
      expect(tpl).toContain(k);
  });
});
