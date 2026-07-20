import { describe, it, expect } from "vitest";
import { deployAws, registerAwsApp, statusAws, envAws, logsAws, destroyAws } from "../src/targets/aws";
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
  const createdStacks = new Set<string>();
  let statusIdx = 0;
  const send = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetParameterCommand") {
      if (c.input.Name === "/keel/db/api/url") return { Parameter: { Value: "postgres://api:pw@db.example:5432/api?sslmode=require" } };
      return { Parameter: { Value: "secret" } };
    }
    if (cmd === "ScanCommand") return { Items: [] };
    if (cmd === "GetCommand") {
      const pk = String(c.input.Key.PK);
      if (pk.startsWith("DB#")) {
        if (pk === "DB#api") {
          return {
            Item: {
              PK: "DB#api", SK: "META", name: "api", project: "api", isolation: "shared",
              access: "public", engine: "postgres", host: "db.example", port: 5432,
              dbName: "api", dbUser: "api", stack: "keel-db-shared", dbSgId: "sg-db", createdAt: "t",
            },
          };
        }
        return {};
      }
      if (pk.startsWith("AUTH#")) {
        if (pk === "AUTH#authapp") {
          return { Item: { PK: "AUTH#authapp", SK: "META", name: "authapp", db: "api", project: "authapp", host: "alb.example:8100", port: 8100, stack: "keel-auth-authapp", taskSgId: "sg-auth", url: "http://alb.example:8100", createdAt: "t" } };
        }
        return {};
      }
      if (String(c.input.Key.SK) === "META") {
        return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t" } };
      }
      const status = deployStatuses[Math.min(statusIdx++, deployStatuses.length - 1)];
      return { Item: { PK: "APP#web", SK: c.input.Key.SK, status, updatedAt: "t" } };
    }
    if (cmd === "StartBuildCommand") return { build: { id: "keel-build:abc123" } };
    if (cmd === "CreateStackCommand") {
      createdStacks.add(c.input.StackName);
      return {};
    }
    if (cmd === "DescribeStacksCommand") {
      const name = c.input.StackName as string;
      if (!createdStacks.has(name)) throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
      const outputs = name === "keel-ingress"
        ? { AlbDns: "alb.example", AlbArn: "arn:alb", AlbSgId: "sg-alb" }
        : { Url: "http://alb.example:8001", TaskSgId: "sg-app" };
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
    }
    if (cmd === "FilterLogEventsCommand") return { events: [{ timestamp: 1720000000000, message: "listening on 3000\n" }] };
    return {};
  };
  const clients = { ddb: { send }, ssm: { send }, codebuild: { send }, cfn: { send }, logs: { send }, ec2: { send } } as any;
  return { calls, io: { gcfg, clients, sleep: async () => {} } };
}

describe("deployAws", () => {
  it("queues a deploy, starts the build with env overrides, and resolves on live", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await deployAws(cfg, io);
    } finally {
      console.log = orig;
    }
    const start = calls.find((c) => c.cmd === "StartBuildCommand")!;
    const envs = Object.fromEntries(start.input.environmentVariablesOverride.map((e: any) => [e.name, e.value]));
    expect(start.input.projectName).toBe("keel-build");
    expect(envs.APP).toBe("web");
    expect(envs.PORT).toBe("3000");
    expect(envs.DEPLOY_ID).toMatch(/^\d{8}T\d{6}Z$/);
    const queued = calls.find((c) => c.cmd === "PutCommand" && String(c.input.Item.SK).startsWith("DEPLOY#"))!;
    expect(queued.input.Item.status).toBe("queued");

    const ingressCreateIdx = calls.findIndex((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-ingress");
    const startBuildIdx = calls.findIndex((c) => c.cmd === "StartBuildCommand");
    expect(ingressCreateIdx).toBeGreaterThanOrEqual(0);
    expect(ingressCreateIdx).toBeLessThan(startBuildIdx);
    const appStack = calls.find((c) => c.cmd === "CreateStackCommand" && String(c.input.StackName).startsWith("keel-app-"));
    expect(appStack).toBeDefined();
    const appParams = Object.fromEntries(appStack!.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(appParams.DbSgId).toBe("");
    expect(logs.some((l) => l.includes("http://alb.example:8001"))).toBe(true);
  });

  it("throws with the codebuild console hint when the build fails", async () => {
    const { io } = fakeIo(["building", "failed"]);
    await expect(deployAws(cfg, io)).rejects.toThrow(/codebuild/i);
  });

  it("times out after a bounded number of polls instead of hanging on a status that never resolves", async () => {
    const { io } = fakeIo(["building"]); // never reaches live or failed
    await expect(deployAws(cfg, io)).rejects.toThrow(/timed out/i);
  });

  it("deployAws with a linked db injects DATABASE_URL before the build and grants via the app stack", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const dbCfg = { ...cfg, db: "api" };
    const orig = console.log;
    console.log = () => {};
    try {
      await deployAws(dbCfg, io);
    } finally {
      console.log = orig;
    }
    const putUrlIdx = calls.findIndex((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/web/env/DATABASE_URL");
    const startBuildIdx = calls.findIndex((c) => c.cmd === "StartBuildCommand");
    expect(putUrlIdx).toBeGreaterThanOrEqual(0);
    expect(putUrlIdx).toBeLessThan(startBuildIdx);
    // apps get encrypt-without-verify — RDS certs chain to Amazon's CA the image doesn't trust
    expect(calls[putUrlIdx].input.Value).toBe("postgres://api:pw@db.example:5432/api?sslmode=no-verify");

    const appStack = calls.find((c) => c.cmd === "CreateStackCommand" && c.input.StackName === "keel-app-web");
    const appParams = Object.fromEntries(appStack!.input.Parameters.map((p: any) => [p.ParameterKey, p.ParameterValue]));
    expect(appParams.DbSgId).toBe("sg-db");
    expect(calls.some((c) => c.cmd === "AuthorizeSecurityGroupIngressCommand")).toBe(false);
  });

  it("deployAws with dbSslRootCert injects verify-full pointed at the app's CA bundle", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const dbCfg = { ...cfg, db: "api", dbSslRootCert: "/rds-ca.pem" };
    const orig = console.log;
    console.log = () => {};
    try {
      await deployAws(dbCfg, io);
    } finally {
      console.log = orig;
    }
    const put = calls.find((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/web/env/DATABASE_URL");
    expect(put!.input.Value).toBe("postgres://api:pw@db.example:5432/api?sslmode=verify-full&sslrootcert=/rds-ca.pem");
  });

  it("deployAws with a missing db fails fast", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const dbCfg = { ...cfg, db: "missing" };
    await expect(deployAws(dbCfg, io)).rejects.toThrow(/keel db create missing/);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(false);
  });

  it("deployAws with a linked auth injects GOTRUE_URL + JWT_SECRET before the build", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const authCfg = { ...cfg, auth: "authapp" };
    const orig = console.log;
    console.log = () => {};
    try {
      await deployAws(authCfg, io);
    } finally {
      console.log = orig;
    }
    const gotrueIdx = calls.findIndex((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/web/env/GOTRUE_URL");
    const jwtIdx = calls.findIndex((c) => c.cmd === "PutParameterCommand" && c.input.Name === "/keel/web/env/JWT_SECRET");
    const startBuildIdx = calls.findIndex((c) => c.cmd === "StartBuildCommand");
    expect(gotrueIdx).toBeGreaterThanOrEqual(0);
    expect(jwtIdx).toBeGreaterThanOrEqual(0);
    expect(Math.max(gotrueIdx, jwtIdx)).toBeLessThan(startBuildIdx);
  });

  it("deployAws with a missing auth fails fast", async () => {
    const { calls, io } = fakeIo(["queued", "building", "live"]);
    const authCfg = { ...cfg, auth: "missing" };
    await expect(deployAws(authCfg, io)).rejects.toThrow(/keel auth create missing/);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(false);
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
    const put = calls.find((c) => c.cmd === "PutCommand" && c.input.Item.SK === "META")!;
    expect(put.input.Item.albPort).toBe(8001);
    const text = logs.join("\n");
    expect(text).toContain("https://api.example.com/hook/web");
    expect(text).toContain("gh api repos/me/web/hooks");
  });

  it("allocates the next albPort above the highest already in use", async () => {
    const puts: any[] = [];
    const send = async (c: any) => {
      const cmd = c.constructor.name;
      if (cmd === "ScanCommand") return { Items: [{ albPort: 8001 }, { albPort: 8003 }] };
      if (cmd === "PutCommand") { puts.push(c.input); return {}; }
      if (cmd === "GetParameterCommand") return { Parameter: { Value: "secret" } };
      return {};
    };
    const io = { gcfg, clients: { ddb: { send }, ssm: { send }, codebuild: { send }, cfn: { send } } as any, sleep: async () => {} };
    const orig = console.log;
    console.log = () => {};
    try {
      await registerAwsApp(cfg, io);
    } finally {
      console.log = orig;
    }
    const put = puts.find((i) => i.Item.SK === "META")!;
    expect(put.Item.albPort).toBe(8004);
  });
});

describe("statusAws", () => {
  it("prints ids and statuses for recent deploys", async () => {
    const send = async (c: any) => {
      if (c.constructor.name === "QueryCommand") {
        return {
          Items: [
            { SK: "DEPLOY#20260101T000000Z", status: "live", updatedAt: "t1" },
            { SK: "DEPLOY#20260102T000000Z", status: "building", updatedAt: "t2" },
          ],
        };
      }
      return {};
    };
    const io = { gcfg, clients: { ddb: { send }, ssm: { send }, codebuild: { send } } as any, sleep: async () => {} };
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await statusAws(cfg, io);
    } finally {
      console.log = orig;
    }
    const text = logs.join("\n");
    expect(text).toContain("20260101T000000Z");
    expect(text).toContain("live");
    expect(text).toContain("20260102T000000Z");
    expect(text).toContain("building");
  });
});

describe("envAws", () => {
  it("set writes a PutParameterCommand under /keel/<app>/env/<KEY>", async () => {
    const calls: Array<{ cmd: string; input: any }> = [];
    const send = async (c: any) => { calls.push({ cmd: c.constructor.name, input: c.input }); return {}; };
    const io = { gcfg, clients: { ddb: { send }, ssm: { send }, codebuild: { send } } as any, sleep: async () => {} };
    await envAws("set", ["A=1"], cfg, io);
    const put = calls.find((c) => c.cmd === "PutParameterCommand")!;
    expect(put.input.Name).toBe("/keel/web/env/A");
    expect(put.input.Value).toBe("1");
  });

  it("list prints KEY=VALUE from GetParametersByPath", async () => {
    const send = async (c: any) => {
      if (c.constructor.name === "GetParametersByPathCommand") {
        return { Parameters: [{ Name: "/keel/web/env/A", Value: "1" }] };
      }
      return {};
    };
    const io = { gcfg, clients: { ddb: { send }, ssm: { send }, codebuild: { send } } as any, sleep: async () => {} };
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await envAws("list", [], cfg, io);
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("A=1");
  });

  it("unset sends a DeleteParameterCommand", async () => {
    const calls: Array<{ cmd: string; input: any }> = [];
    const send = async (c: any) => { calls.push({ cmd: c.constructor.name, input: c.input }); return {}; };
    const io = { gcfg, clients: { ddb: { send }, ssm: { send }, codebuild: { send } } as any, sleep: async () => {} };
    await envAws("unset", ["A"], cfg, io);
    expect(calls.some((c) => c.cmd === "DeleteParameterCommand" && c.input.Name === "/keel/web/env/A")).toBe(true);
  });
});

describe("deployAws auto-register", () => {
  it("registers the app automatically when META is missing, then proceeds to StartBuild", async () => {
    const calls: Array<{ cmd: string; input: any }> = [];
    const createdStacks = new Set<string>();
    let metaCalls = 0;
    let statusIdx = 0;
    const deployStatuses = ["queued", "live"];
    const send = async (c: any) => {
      const cmd = c.constructor.name;
      calls.push({ cmd, input: c.input });
      if (cmd === "GetParameterCommand") return { Parameter: { Value: "secret" } };
      if (cmd === "ScanCommand") return { Items: [] };
      if (cmd === "GetCommand") {
        if (String(c.input.Key.SK) === "META") {
          metaCalls++;
          if (metaCalls === 1) return {}; // not registered yet — triggers auto-register
          return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t", albPort: 8001 } };
        }
        const status = deployStatuses[Math.min(statusIdx++, deployStatuses.length - 1)];
        return { Item: { PK: "APP#web", SK: c.input.Key.SK, status, updatedAt: "t" } };
      }
      if (cmd === "StartBuildCommand") return { build: { id: "keel-build:abc123" } };
      if (cmd === "CreateStackCommand") { createdStacks.add(c.input.StackName); return {}; }
      if (cmd === "DescribeStacksCommand") {
        const name = c.input.StackName as string;
        if (!createdStacks.has(name)) throw Object.assign(new Error("does not exist"), { name: "ValidationError" });
        const outputs = name === "keel-ingress"
          ? { AlbDns: "alb.example", AlbArn: "arn:alb", AlbSgId: "sg-alb", TaskSgId: "sg-task" }
          : { Url: "http://alb.example:8001" };
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: Object.entries(outputs).map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    };
    const clients = { ddb: { send }, ssm: { send }, codebuild: { send }, cfn: { send }, logs: { send } } as any;
    const orig = console.log;
    console.log = () => {};
    try {
      await deployAws(cfg, { gcfg, clients, sleep: async () => {} });
    } finally {
      console.log = orig;
    }
    expect(calls.some((c) => c.cmd === "PutCommand" && c.input.Item.SK === "META")).toBe(true);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(true);
  });
});

describe("logsAws", () => {
  it("prints cloudwatch events", async () => {
    const { io } = fakeIo([]);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      await logsAws(cfg, io, {});
    } finally {
      console.log = orig;
    }
    const text = logs.join("\n");
    expect(text).toContain("listening on 3000");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("targets /keel/apps filtered by app name", async () => {
    const { calls, io } = fakeIo([]);
    const orig = console.log;
    console.log = () => {};
    try {
      await logsAws(cfg, io, {});
    } finally {
      console.log = orig;
    }
    const filterCmd = calls.find((c) => c.cmd === "FilterLogEventsCommand");
    expect(filterCmd).toBeDefined();
    expect(filterCmd!.input.logGroupName).toBe("/keel/apps");
    expect(filterCmd!.input.logStreamNamePrefix).toBe("web");
  });
});

function fakeDestroyIo(opts: { registered?: boolean } = {}) {
  const registered = opts.registered ?? true;
  const calls: Array<{ cmd: string; input: any }> = [];
  const send = async (c: any) => {
    const cmd = c.constructor.name;
    calls.push({ cmd, input: c.input });
    if (cmd === "GetCommand") {
      if (!registered) return {};
      return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t" } };
    }
    if (cmd === "DescribeStacksCommand") return { Stacks: [{ StackStatus: "DELETE_COMPLETE" }] };
    if (cmd === "QueryCommand") return { Items: [{ PK: "APP#web", SK: "META" }, { PK: "APP#web", SK: "DEPLOY#x" }] };
    if (cmd === "GetParametersByPathCommand") {
      return { Parameters: [{ Name: "/keel/web/webhook-secret" }, { Name: "/keel/web/env/API_KEY" }] };
    }
    return {};
  };
  const clients = { ddb: { send }, ssm: { send }, cfn: { send } } as any;
  return { calls, io: { gcfg, clients, sleep: async () => {} } };
}

describe("destroyAws", () => {
  it("deletes the app stack", async () => {
    const { calls, io } = fakeDestroyIo();
    const orig = console.log;
    console.log = () => {};
    try {
      await destroyAws(cfg, io);
    } finally {
      console.log = orig;
    }
    const del = calls.find((c) => c.cmd === "DeleteStackCommand");
    expect(del).toBeDefined();
    expect(del!.input.StackName).toBe("keel-app-web");
  });

  it("deletes ddb records and ssm params", async () => {
    const { calls, io } = fakeDestroyIo();
    const orig = console.log;
    console.log = () => {};
    try {
      await destroyAws(cfg, io);
    } finally {
      console.log = orig;
    }
    expect(calls.filter((c) => c.cmd === "DeleteCommand")).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === "DeleteParameterCommand")).toHaveLength(2);
  });

  it("throws when app not registered", async () => {
    const { io } = fakeDestroyIo({ registered: false });
    await expect(destroyAws(cfg, io)).rejects.toThrow(/not registered/);
  });

  it("paginates through SSM params past the first page", async () => {
    const calls: Array<{ cmd: string; input: any }> = [];
    const send = async (c: any) => {
      const cmd = c.constructor.name;
      calls.push({ cmd, input: c.input });
      if (cmd === "GetCommand") {
        return { Item: { PK: "APP#web", SK: "META", name: "web", repo: cfg.repo, branch: "main", port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "t" } };
      }
      if (cmd === "DescribeStacksCommand") return { Stacks: [{ StackStatus: "DELETE_COMPLETE" }] };
      if (cmd === "QueryCommand") return { Items: [] };
      if (cmd === "GetParametersByPathCommand") {
        if (!c.input.NextToken) return { Parameters: [{ Name: "/keel/web/webhook-secret" }], NextToken: "page2" };
        return { Parameters: [{ Name: "/keel/web/env/API_KEY" }] };
      }
      return {};
    };
    const clients = { ddb: { send }, ssm: { send }, cfn: { send } } as any;
    const orig = console.log;
    console.log = () => {};
    try {
      await destroyAws(cfg, { gcfg, clients, sleep: async () => {} });
    } finally {
      console.log = orig;
    }
    expect(calls.filter((c) => c.cmd === "GetParametersByPathCommand")).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === "DeleteParameterCommand")).toHaveLength(2);
  });
});
