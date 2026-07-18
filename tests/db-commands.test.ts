import { describe, it, expect } from "vitest";
import { dbCreate, dbList, dbUrl, dbAllowIp, dbDestroy } from "../src/commands/db";
import type { PgFactory } from "../src/aws/pgadmin";

const gcfg = {
  region: "ap-south-1",
  controlPlane: {
    stackName: "keel-control-plane", tableName: "keel", clusterName: "keel",
    ecrRepoUri: "1.dkr.ecr.x/keel-apps", buildProject: "keel-build",
    webhookBase: "https://api.example.com/hook",
    taskExecRoleArn: "arn:x", logGroup: "/keel/apps", vpcId: "vpc-1", subnetIds: ["s-1"],
  },
} as any;

function fakePg() {
  const queries: string[] = [];
  const factory: PgFactory = () => ({
    connect: async () => {},
    query: async (sql: string) => { queries.push(sql); },
    end: async () => {},
  });
  return { queries, factory };
}

function fakeFetch(ip = "9.9.9.9") {
  return (async () => ({ text: async () => `${ip}\n` })) as any;
}

function makeEnv() {
  const calls: Array<{ cmd: string; input: any }> = [];
  const createdStacks = new Set<string>();
  const deletedStacks = new Set<string>();
  const ssmParams = new Map<string, string>();
  const dbRecords = new Map<string, any>();

  const cfnSend = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "CreateStackCommand" || cmd === "UpdateStackCommand") { createdStacks.add(c.input.StackName); return {}; }
    if (cmd === "DeleteStackCommand") { deletedStacks.add(c.input.StackName); createdStacks.delete(c.input.StackName); return {}; }
    if (cmd === "DescribeStacksCommand") {
      const name = c.input.StackName as string;
      if (deletedStacks.has(name)) return { Stacks: [{ StackStatus: "DELETE_COMPLETE" }] };
      if (!createdStacks.has(name)) throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
      const outputs = { Endpoint: `${name}.rds.example`, DbSgId: `sg-${name}` };
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    }
    return {};
  };

  const ssmSend = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetParameterCommand") {
      const v = ssmParams.get(c.input.Name);
      if (v === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
      return { Parameter: { Value: v } };
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
    if (cmd === "PutCommand") { dbRecords.set(c.input.Item.name, c.input.Item); return {}; }
    if (cmd === "GetCommand") {
      const name = String(c.input.Key.PK).replace("DB#", "");
      const item = dbRecords.get(name);
      return item ? { Item: item } : {};
    }
    if (cmd === "ScanCommand") return { Items: [...dbRecords.values()] };
    if (cmd === "DeleteCommand") {
      const name = String(c.input.Key.PK).replace("DB#", "");
      dbRecords.delete(name);
      return {};
    }
    return {};
  };

  const ec2Send = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "DescribeSecurityGroupRulesCommand") return { SecurityGroupRules: [] };
    return {};
  };

  const clients = { cfn: { send: cfnSend }, ssm: { send: ssmSend }, ddb: { send: ddbSend }, ec2: { send: ec2Send } } as any;
  return { calls, ssmParams, dbRecords, clients };
}

async function withoutLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = orig;
  }
}

describe("dbCreate shared", () => {
  it("creates the shared instance, sets master IP rule, runs CREATE ROLE/DATABASE, stores url + record", async () => {
    const { calls, ssmParams, dbRecords, clients } = makeEnv();
    const { queries, factory } = fakePg();
    const io = { gcfg, clients, pg: factory, fetchImpl: fakeFetch() };
    const { logs } = await withoutLogs(() => dbCreate("api", {}, io));

    expect(calls.some((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-db-shared")).toBe(true);
    expect(calls.some((c) => c.cmd === "AuthorizeSecurityGroupIngressCommand")).toBe(true);
    expect(queries.some((q) => q.includes("CREATE ROLE"))).toBe(true);
    expect(queries.some((q) => q.includes("CREATE DATABASE"))).toBe(true);
    expect(ssmParams.get("/keel/db/api/url")).toMatch(/^postgres:\/\/api:/);
    const rec = dbRecords.get("api");
    expect(rec.isolation).toBe("shared");
    expect(rec.dbUser).toBe("api");
    expect(rec.stack).toBe("keel-db-shared");
    expect(logs.join("\n")).toContain("~8 minutes");
  });
});

describe("dbCreate dedicated", () => {
  it("creates its own stack with DbName param, runs no pg SQL, dbUser is keeladmin", async () => {
    const { calls, ssmParams, dbRecords, clients } = makeEnv();
    const { queries, factory } = fakePg();
    const io = { gcfg, clients, pg: factory, fetchImpl: fakeFetch() };
    await withoutLogs(() => dbCreate("api", { isolation: "dedicated" }, io));

    const create = calls.find((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-db-api")!;
    expect(create).toBeDefined();
    const params = Object.fromEntries(create.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(params.DbName).toBe("api");
    expect(queries).toHaveLength(0);
    const rec = dbRecords.get("api");
    expect(rec.dbUser).toBe("keeladmin");
    expect(rec.stack).toBe("keel-db-api");
    expect(ssmParams.get("/keel/db/api/url")).toMatch(/^postgres:\/\/keeladmin:/);
  });
});

describe("dbCreate validation", () => {
  it("rejects a duplicate name", async () => {
    const { clients, dbRecords } = makeEnv();
    dbRecords.set("api", { name: "api", isolation: "shared" });
    const io = { gcfg, clients, fetchImpl: fakeFetch() };
    await expect(dbCreate("api", {}, io)).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid name before any AWS call", async () => {
    const { calls, clients } = makeEnv();
    const io = { gcfg, clients, fetchImpl: fakeFetch() };
    await expect(dbCreate("API-1", {}, io)).rejects.toThrow(/invalid/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown isolation mode", async () => {
    const { clients } = makeEnv();
    const io = { gcfg, clients, fetchImpl: fakeFetch() };
    await expect(dbCreate("api", { isolation: "cloud" }, io)).rejects.toThrow(/isolation/i);
  });

  it("rejects underscores in dedicated databases before any AWS call", async () => {
    const { calls, clients } = makeEnv();
    const io = { gcfg, clients, fetchImpl: fakeFetch() };
    await expect(dbCreate("api_db", { isolation: "dedicated" }, io)).rejects.toThrow(/underscores/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects reserved 'postgres' name in dedicated databases", async () => {
    const { calls, clients } = makeEnv();
    const io = { gcfg, clients, fetchImpl: fakeFetch() };
    await expect(dbCreate("postgres", { isolation: "dedicated" }, io)).rejects.toThrow(/reserved/i);
    expect(calls).toHaveLength(0);
  });

  it("allows underscores in shared databases", async () => {
    const { calls, clients, dbRecords } = makeEnv();
    const { queries, factory } = fakePg();
    const io = { gcfg, clients, pg: factory, fetchImpl: fakeFetch() };
    await withoutLogs(() => dbCreate("api_db", { isolation: "shared" }, io));
    expect(calls.some((c) => c.cmd === "CreateStackCommand")).toBe(true);
    const rec = dbRecords.get("api_db");
    expect(rec.isolation).toBe("shared");
  });
});

describe("dbList", () => {
  it("prints a placeholder when empty", async () => {
    const { clients } = makeEnv();
    const { logs } = await withoutLogs(() => dbList({ gcfg, clients }));
    expect(logs.join("\n")).toContain("keel db create");
  });

  it("prints name, isolation, project, host per record", async () => {
    const { clients, dbRecords } = makeEnv();
    dbRecords.set("api", { name: "api", isolation: "shared", project: "api", host: "h1" });
    const { logs } = await withoutLogs(() => dbList({ gcfg, clients }));
    const text = logs.join("\n");
    expect(text).toContain("api");
    expect(text).toContain("shared");
    expect(text).toContain("h1");
  });
});

describe("dbUrl", () => {
  it("prints the stored url", async () => {
    const { clients, ssmParams } = makeEnv();
    ssmParams.set("/keel/db/api/url", "postgres://api:pw@host/api");
    const { logs } = await withoutLogs(() => dbUrl("api", { gcfg, clients }));
    expect(logs.join("\n")).toContain("postgres://api:pw@host/api");
  });

  it("throws an actionable error when missing", async () => {
    const { clients } = makeEnv();
    await expect(dbUrl("nope", { gcfg, clients })).rejects.toThrow(/keel db create nope/);
  });
});

describe("dbAllowIp", () => {
  it("uses the injected fetch IP and calls one Authorize per unique security group", async () => {
    const { calls, dbRecords, clients } = makeEnv();
    dbRecords.set("api", { name: "api", project: "api", isolation: "shared", host: "h1", dbSgId: "sg-shared", stack: "keel-db-shared", dbUser: "api", dbName: "api", port: 5432, access: "public", engine: "postgres", createdAt: "t" });
    dbRecords.set("other", { name: "other", project: "other", isolation: "shared", host: "h1", dbSgId: "sg-shared", stack: "keel-db-shared", dbUser: "other", dbName: "other", port: 5432, access: "public", engine: "postgres", createdAt: "t" });
    dbRecords.set("solo", { name: "solo", project: "solo", isolation: "dedicated", host: "h2", dbSgId: "sg-solo", stack: "keel-db-solo", dbUser: "keeladmin", dbName: "solo", port: 5432, access: "public", engine: "postgres", createdAt: "t" });
    const io = { gcfg, clients, fetchImpl: fakeFetch("5.5.5.5") };
    const { logs } = await withoutLogs(() => dbAllowIp({}, io));

    const authCalls = calls.filter((c) => c.cmd === "AuthorizeSecurityGroupIngressCommand");
    expect(authCalls).toHaveLength(2);
    expect(authCalls.every((c) => c.input.IpPermissions[0].IpRanges[0].CidrIp === "5.5.5.5/32")).toBe(true);
    expect(logs.join("\n")).toContain("2 security group");
  });
});

describe("dbDestroy shared", () => {
  it("drops the logical db, deletes the url param, and deletes the record", async () => {
    const { calls, ssmParams, dbRecords, clients } = makeEnv();
    ssmParams.set("/keel/db-shared/master", "masterpw");
    ssmParams.set("/keel/db/api/url", "postgres://api:pw@host/api");
    dbRecords.set("api", {
      name: "api", project: "api", isolation: "shared", host: "keel-db-shared.rds.example",
      dbSgId: "sg-keel-db-shared", stack: "keel-db-shared", dbUser: "api", dbName: "api",
      port: 5432, access: "public", engine: "postgres", createdAt: "t",
    });
    const { queries, factory } = fakePg();
    const io = { gcfg, clients, pg: factory };
    await withoutLogs(() => dbDestroy("api", io));

    expect(queries.some((q) => q.startsWith("DROP DATABASE"))).toBe(true);
    expect(queries.some((q) => q.startsWith("DROP ROLE"))).toBe(true);
    expect(ssmParams.has("/keel/db/api/url")).toBe(false);
    expect(dbRecords.has("api")).toBe(false);
    expect(calls.some((c) => c.cmd === "DeleteStackCommand")).toBe(false);
  });

  it("hints at the still-running shared instance when no shared dbs remain", async () => {
    const { ssmParams, dbRecords, clients } = makeEnv();
    ssmParams.set("/keel/db-shared/master", "masterpw");
    ssmParams.set("/keel/db/api/url", "postgres://api:pw@host/api");
    dbRecords.set("api", {
      name: "api", project: "api", isolation: "shared", host: "keel-db-shared.rds.example",
      dbSgId: "sg-keel-db-shared", stack: "keel-db-shared", dbUser: "api", dbName: "api",
      port: 5432, access: "public", engine: "postgres", createdAt: "t",
    });
    const { factory } = fakePg();
    const { logs } = await withoutLogs(() => dbDestroy("api", { gcfg, clients, pg: factory }));
    expect(logs.join("\n")).toContain("delete-stack --stack-name keel-db-shared");
  });
});

describe("dbDestroy dedicated", () => {
  it("deletes the stack and both master + url params", async () => {
    const { calls, ssmParams, dbRecords, clients } = makeEnv();
    ssmParams.set("/keel/db/api/master", "masterpw");
    ssmParams.set("/keel/db/api/url", "postgres://keeladmin:pw@host/api");
    dbRecords.set("api", {
      name: "api", project: "api", isolation: "dedicated", host: "keel-db-api.rds.example",
      dbSgId: "sg-keel-db-api", stack: "keel-db-api", dbUser: "keeladmin", dbName: "api",
      port: 5432, access: "public", engine: "postgres", createdAt: "t",
    });
    await withoutLogs(() => dbDestroy("api", { gcfg, clients }));

    expect(calls.some((c) => c.cmd === "DeleteStackCommand" && c.input.StackName === "keel-db-api")).toBe(true);
    expect(ssmParams.has("/keel/db/api/master")).toBe(false);
    expect(ssmParams.has("/keel/db/api/url")).toBe(false);
    expect(dbRecords.has("api")).toBe(false);
  });
});

describe("dbDestroy validation", () => {
  it("throws when the database is not registered", async () => {
    const { clients } = makeEnv();
    await expect(dbDestroy("nope", { gcfg, clients })).rejects.toThrow(/not found/);
  });
});
