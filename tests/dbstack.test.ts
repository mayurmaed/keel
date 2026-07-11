import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ensureDbInstance, getMyIp, setMasterIpRule, allowAppSg } from "../src/aws/dbstack";

function fakeClients(outputs: Record<string, string>) {
  const calls: string[] = [];
  const params: any[] = [];
  const cfn = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push(cmd);
      if (cmd === "CreateStackCommand" || cmd === "UpdateStackCommand") params.push(c.input.Parameters);
      if (cmd === "DescribeStacksCommand") {
        if (!calls.includes("CreateStackCommand")) {
          throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
        }
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    },
  };
  return { calls, params, cfn };
}

function fakeSsm(existing?: string) {
  const calls: string[] = [];
  const puts: any[] = [];
  const ssm = {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push(cmd);
      if (cmd === "GetParameterCommand") {
        if (existing === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: existing } };
      }
      if (cmd === "PutParameterCommand") {
        puts.push(c.input);
      }
      return {};
    },
  };
  return { calls, puts, ssm };
}

const gcfg = { region: "ap-south-1", ingress: "port", controlPlane: { vpcId: "vpc-1", subnetIds: ["s-1", "s-2"] } } as any;

describe("ensureDbInstance", () => {
  it("generates and stores a hex master password when missing, deploys the stack, returns outputs", async () => {
    const { cfn, params } = fakeClients({ Endpoint: "db.example.rds.amazonaws.com", DbSgId: "sg-db" });
    const { ssm, puts } = fakeSsm();
    const info = await ensureDbInstance({ cfn, ssm } as any, gcfg, {
      stackName: "keel-db-main", instanceId: "main", masterPasswordSsm: "/keel/db/main/master-password",
    });

    expect(puts).toHaveLength(1);
    expect(puts[0].Type).toBe("SecureString");
    expect(puts[0].Value).toMatch(/^[0-9a-f]{48}$/);

    const p = Object.fromEntries(params[0].map((x: any) => [x.ParameterKey, x.ParameterValue]));
    expect(p.MasterPassword).toBe(puts[0].Value);
    expect(p.DbName).toBe("");
    expect(p.VpcId).toBe("vpc-1");
    expect(p.Subnets).toBe("s-1,s-2");

    expect(info).toEqual({ host: "db.example.rds.amazonaws.com", dbSgId: "sg-db", masterPassword: puts[0].Value });
  });

  it("reuses an existing stored master password without writing a new one", async () => {
    const { cfn } = fakeClients({ Endpoint: "db.example.rds.amazonaws.com", DbSgId: "sg-db" });
    const { ssm, puts } = fakeSsm("existing-pw");
    const info = await ensureDbInstance({ cfn, ssm } as any, gcfg, {
      stackName: "keel-db-main", instanceId: "main", masterPasswordSsm: "/keel/db/main/master-password",
    });
    expect(puts).toHaveLength(0);
    expect(info.masterPassword).toBe("existing-pw");
  });

  it("passes DbName when provided", async () => {
    const { cfn, params } = fakeClients({ Endpoint: "d", DbSgId: "s" });
    const { ssm } = fakeSsm("pw");
    await ensureDbInstance({ cfn, ssm } as any, gcfg, {
      stackName: "keel-db-api", instanceId: "api", masterPasswordSsm: "/keel/db/api/master-password", dbName: "api",
    });
    const p = Object.fromEntries(params[0].map((x: any) => [x.ParameterKey, x.ParameterValue]));
    expect(p.DbName).toBe("api");
  });

  it("throws if control plane is not set up", async () => {
    const { cfn } = fakeClients({});
    const { ssm } = fakeSsm("pw");
    await expect(
      ensureDbInstance({ cfn, ssm } as any, { region: "x", ingress: "port" } as any, {
        stackName: "s", instanceId: "i", masterPasswordSsm: "p",
      }),
    ).rejects.toThrow(/keel setup/);
  });
});

describe("getMyIp", () => {
  it("returns the trimmed IP from an injected fetch", async () => {
    const fetchImpl = (async () => ({ text: async () => "1.2.3.4\n" })) as any;
    expect(await getMyIp(fetchImpl)).toBe("1.2.3.4");
  });

  it("throws an actionable error on garbage response", async () => {
    const fetchImpl = (async () => ({ text: async () => "<html>" })) as any;
    await expect(getMyIp(fetchImpl)).rejects.toThrow(/public IP/);
  });
});

describe("setMasterIpRule", () => {
  it("revokes only keel:master rules then authorizes the new /32", async () => {
    const calls: { cmd: string; input: any }[] = [];
    const ec2 = {
      send: async (c: any) => {
        const cmd = c.constructor.name;
        calls.push({ cmd, input: c.input });
        if (cmd === "DescribeSecurityGroupRulesCommand") {
          return {
            SecurityGroupRules: [
              { SecurityGroupRuleId: "sgr-1", IsEgress: false, Description: "keel:master" },
              { SecurityGroupRuleId: "sgr-2", IsEgress: false, Description: "other" },
            ],
          };
        }
        return {};
      },
    };
    await setMasterIpRule(ec2, "sg-db", "9.9.9.9");
    const revoke = calls.find((c) => c.cmd === "RevokeSecurityGroupIngressCommand");
    expect(revoke?.input.SecurityGroupRuleIds).toEqual(["sgr-1"]);
    const authorize = calls.find((c) => c.cmd === "AuthorizeSecurityGroupIngressCommand");
    expect(authorize?.input.IpPermissions[0].IpRanges[0].CidrIp).toBe("9.9.9.9/32");
    expect(authorize?.input.IpPermissions[0].IpRanges[0].Description).toBe("keel:master");
  });

  it("skips revoke when no stale rules exist", async () => {
    const calls: string[] = [];
    const ec2 = {
      send: async (c: any) => {
        calls.push(c.constructor.name);
        if (c.constructor.name === "DescribeSecurityGroupRulesCommand") return { SecurityGroupRules: [] };
        return {};
      },
    };
    await setMasterIpRule(ec2, "sg-db", "1.1.1.1");
    expect(calls).not.toContain("RevokeSecurityGroupIngressCommand");
  });
});

describe("allowAppSg", () => {
  it("authorizes the app SG pair", async () => {
    const calls: { cmd: string; input: any }[] = [];
    const ec2 = { send: async (c: any) => { calls.push({ cmd: c.constructor.name, input: c.input }); return {}; } };
    await allowAppSg(ec2, "sg-db", "sg-app", "myapp");
    const authorize = calls.find((c) => c.cmd === "AuthorizeSecurityGroupIngressCommand");
    expect(authorize?.input.IpPermissions[0].UserIdGroupPairs[0]).toEqual({ GroupId: "sg-app", Description: "keel:app:myapp" });
  });

  it("swallows InvalidPermission.Duplicate", async () => {
    const ec2 = { send: async () => { throw Object.assign(new Error("dup"), { name: "InvalidPermission.Duplicate" }); } };
    await expect(allowAppSg(ec2, "sg-db", "sg-app", "myapp")).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    const ec2 = { send: async () => { throw Object.assign(new Error("boom"), { name: "SomethingElse" }); } };
    await expect(allowAppSg(ec2, "sg-db", "sg-app", "myapp")).rejects.toThrow(/boom/);
  });
});

describe("db template", () => {
  const tpl = readFileSync("infra/db.yaml", "utf8");
  it("declares the RDS instance, no-echo password, encryption, and security group output", () => {
    for (const k of ["AWS::RDS::DBInstance", "NoEcho", "StorageEncrypted", "DbSgId"]) expect(tpl).toContain(k);
  });
});
