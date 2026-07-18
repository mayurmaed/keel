import { describe, it, expect } from "vitest";
import { authCreate, authDestroy } from "../src/commands/auth";

const gcfg = {
  region: "ap-south-1", ingress: "port",
  controlPlane: {
    stackName: "keel-control-plane", tableName: "keel", clusterName: "keel",
    ecrRepoUri: "1.dkr.ecr.x/keel-apps", buildProject: "keel-build",
    webhookBase: "https://api.example.com/hook", taskExecRoleArn: "arn:x",
    logGroup: "/keel/apps", vpcId: "vpc-1", subnetIds: ["s-1"],
  },
} as any;

function makeEnv() {
  const calls: Array<{ cmd: string; input: any }> = [];
  const createdStacks = new Set<string>();
  const deletedStacks = new Set<string>();
  const ssmParams = new Map<string, string>();
  const dbRecords = new Map<string, any>();
  const authRecords = new Map<string, any>();

  const cfnSend = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "CreateStackCommand" || cmd === "UpdateStackCommand") {
      createdStacks.add(c.input.StackName);
      return {};
    }
    if (cmd === "DeleteStackCommand") {
      deletedStacks.add(c.input.StackName);
      createdStacks.delete(c.input.StackName);
      return {};
    }
    if (cmd === "DescribeStacksCommand") {
      const name = c.input.StackName as string;
      if (deletedStacks.has(name)) return { Stacks: [{ StackStatus: "DELETE_COMPLETE" }] };
      if (!createdStacks.has(name)) throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
      const outputs = name === "keel-ingress"
        ? { AlbDns: "alb.example", AlbArn: "arn:alb", AlbSgId: "sg-alb" }
        : { Url: "http://alb.example:8100", TaskSgId: "sg-auth" };
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    }
    return {};
  };

  const ssmSend = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetParameterCommand") {
      const value = ssmParams.get(c.input.Name);
      if (value === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
      return { Parameter: { Value: value } };
    }
    if (cmd === "PutParameterCommand") { ssmParams.set(c.input.Name, c.input.Value); return {}; }
    if (cmd === "DeleteParameterCommand") {
      if (!ssmParams.has(c.input.Name)) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
      ssmParams.delete(c.input.Name);
      return {};
    }
    return {};
  };

  const ddbSend = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "PutCommand") {
      const records = c.input.Item.PK.startsWith("DB#") ? dbRecords : authRecords;
      records.set(c.input.Item.name, c.input.Item);
      return {};
    }
    if (cmd === "GetCommand") {
      const [kind, name] = String(c.input.Key.PK).split("#");
      const item = (kind === "DB" ? dbRecords : authRecords).get(name);
      return item ? { Item: item } : {};
    }
    if (cmd === "ScanCommand") return { Items: [...authRecords.values()] };
    if (cmd === "DeleteCommand") {
      authRecords.delete(String(c.input.Key.PK).replace("AUTH#", ""));
      return {};
    }
    return {};
  };

  const pgQueries: string[] = [];
  const pg: any = () => ({
    connect: async () => {},
    query: async (sql: string) => { pgQueries.push(sql); },
    end: async () => {},
  });

  const ec2Send = async (c: any) => {
    calls.push({ cmd: c.constructor.name, input: c.input });
    if (c.constructor.name === "DescribeSecurityGroupRulesCommand") return { SecurityGroupRules: [] };
    return {};
  };
  const fetchImpl: any = async () => ({ text: async () => "1.2.3.4\n" });

  const clients = { cfn: { send: cfnSend }, ssm: { send: ssmSend }, ddb: { send: ddbSend }, ec2: { send: ec2Send } } as any;
  return { calls, ssmParams, dbRecords, authRecords, clients, pg, pgQueries, fetchImpl };
}

async function withoutLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = original;
  }
}

describe("authCreate", () => {
  it("creates its stack, JWT secret, registry record, and URL", async () => {
    const { calls, ssmParams, dbRecords, authRecords, clients, pg, pgQueries, fetchImpl } = makeEnv();
    dbRecords.set("appdb", { name: "appdb", dbSgId: "sg-db" });
    ssmParams.set("/keel/db/appdb/url", "postgres://appdb:pw@host:5432/appdb?sslmode=require");

    const { logs } = await withoutLogs(() => authCreate("appauth", { db: "appdb" }, { gcfg, clients, pg, fetchImpl }));

    expect(calls.some((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-auth-appauth")).toBe(true);
    // GoTrue gets a dedicated role that owns the auth schema with a role-level search_path
    expect(pgQueries.some((q) => /create schema if not exists auth/i.test(q))).toBe(true);
    expect(pgQueries.some((q) => /alter role .* set search_path = auth/i.test(q))).toBe(true);
    const dbUrlPut = calls.find((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/auth/appauth/db-url");
    expect(dbUrlPut?.input.Type).toBe("SecureString");
    expect(dbUrlPut?.input.Value).toContain("keelauth_appauth");
    const secretPut = calls.find((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/auth/appauth/jwt-secret");
    expect(secretPut?.input.Type).toBe("SecureString");
    expect(ssmParams.has("/keel/auth/appauth/jwt-secret")).toBe(true);
    expect(authRecords.get("appauth")).toMatchObject({ PK: "AUTH#appauth", db: "appdb" });
    expect(logs.join("\n")).toContain("http://");
  });

  it("requires a database and checks that it exists", async () => {
    const { clients } = makeEnv();
    await expect(authCreate("appauth", {}, { gcfg, clients })).rejects.toThrow(/--db/);
    await expect(authCreate("appauth", { db: "missing" }, { gcfg, clients })).rejects.toThrow(/keel db create/);
  });

  it("rejects invalid names before any AWS call", async () => {
    const { calls, clients } = makeEnv();
    await expect(authCreate("App_Auth", { db: "appdb" }, { gcfg, clients })).rejects.toThrow(/invalid/i);
    expect(calls).toHaveLength(0);
  });

  it("allocates auth listener ports at 8100 or higher", async () => {
    const { calls, ssmParams, dbRecords, authRecords, clients, pg, fetchImpl } = makeEnv();
    dbRecords.set("appdb", { name: "appdb", dbSgId: "sg-db" });
    ssmParams.set("/keel/db/appdb/url", "postgres://appdb:pw@host:5432/appdb?sslmode=require");
    authRecords.set("existing", { name: "existing", port: 8105 });
    await withoutLogs(() => authCreate("appauth", { db: "appdb" }, { gcfg, clients, pg, fetchImpl }));

    const create = calls.find((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-auth-appauth")!;
    const params = Object.fromEntries(create.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(Number(params.AlbPort)).toBeGreaterThanOrEqual(8100);
  });
});

describe("authDestroy", () => {
  it("deletes its stack, JWT secret, and registry record", async () => {
    const { calls, ssmParams, authRecords, clients } = makeEnv();
    ssmParams.set("/keel/auth/appauth/jwt-secret", "secret");
    ssmParams.set("/keel/auth/appauth/db-url", "postgres://x");
    authRecords.set("appauth", { name: "appauth", db: "appdb" });

    await withoutLogs(() => authDestroy("appauth", { gcfg, clients }));

    expect(calls.some((c) => c.cmd === "DeleteStackCommand" && c.input.StackName === "keel-auth-appauth")).toBe(true);
    expect(calls.some((c) => c.cmd === "DeleteParameterCommand" && c.input.Name === "/keel/auth/appauth/jwt-secret")).toBe(true);
    expect(calls.some((c) => c.cmd === "DeleteParameterCommand" && c.input.Name === "/keel/auth/appauth/db-url")).toBe(true);
    expect(calls.some((c) => c.cmd === "DeleteCommand" && c.input.Key.PK === "AUTH#appauth")).toBe(true);
  });
});
