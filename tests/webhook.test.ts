import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { makeHandler } = require("../infra/webhook-handler.cjs");

process.env.TABLE = "bareboat";
process.env.PROJECT = "bareboat-build";

const appItem = {
  Item: {
    PK: { S: "APP#web" }, SK: { S: "META" },
    repo: { S: "https://github.com/me/web" }, branch: { S: "main" },
    port: { N: "3000" }, cpu: { N: "256" }, memory: { N: "512" },
  },
};

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ client: string; cmd: string; input: any }> = [];
  const mk = (client: string, answers: Record<string, unknown>) => ({
    send: async (c: any) => {
      const cmd = c.constructor.name;
      calls.push({ client, cmd, input: c.input });
      if (cmd in answers) return answers[cmd];
      return {};
    },
  });
  return {
    calls,
    deps: {
      ddb: mk("ddb", { GetItemCommand: overrides.app ?? appItem }),
      ssm: mk("ssm", { GetParameterCommand: { Parameter: { Value: "topsecret" } } }),
      cb: mk("cb", {}),
    },
  };
}

function event(body: string, secret = "topsecret", app = "web") {
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return {
    pathParameters: { app },
    headers: { "x-hub-signature-256": sig },
    body,
    isBase64Encoded: false,
  };
}

const push = JSON.stringify({ ref: "refs/heads/main", after: "abc1234" });

describe("webhook handler", () => {
  it("starts a build on a valid signed push to the tracked branch", async () => {
    const { calls, deps } = fakeDeps();
    const res = await makeHandler(deps)(event(push));
    expect(res.statusCode).toBe(202);
    const start = calls.find((c) => c.cmd === "StartBuildCommand")!;
    expect(start.input.projectName).toBe("bareboat-build");
    const envs = Object.fromEntries(
      start.input.environmentVariablesOverride.map((e: any) => [e.name, e.value]),
    );
    expect(envs.APP).toBe("web");
    expect(envs.BRANCH).toBe("main");
    expect(envs.PORT).toBe("3000");
    expect(calls.find((c) => c.cmd === "PutItemCommand")!.input.Item.status.S).toBe("queued");
  });

  it("rejects a bad signature with 401 and starts nothing", async () => {
    const { calls, deps } = fakeDeps();
    const res = await makeHandler(deps)(event(push, "wrong-secret"));
    expect(res.statusCode).toBe(401);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(false);
  });

  it("ignores unknown apps (204)", async () => {
    const { deps } = fakeDeps({ app: {} });
    expect((await makeHandler(deps)(event(push))).statusCode).toBe(204);
  });

  it("ignores a malformed app record missing branch (204) and starts no build", async () => {
    const { calls, deps } = fakeDeps({
      app: { Item: { PK: { S: "APP#web" }, SK: { S: "META" } } },
    });
    const res = await makeHandler(deps)(event(push));
    expect(res.statusCode).toBe(204);
    expect(calls.some((c) => c.cmd === "StartBuildCommand")).toBe(false);
  });

  it("ignores pushes to other branches (204)", async () => {
    const { deps } = fakeDeps();
    const other = JSON.stringify({ ref: "refs/heads/feature", after: "x" });
    expect((await makeHandler(deps)(event(other))).statusCode).toBe(204);
  });

  it("stays under CloudFormation's 4096-byte ZipFile limit", () => {
    expect(readFileSync("infra/webhook-handler.cjs", "utf8").length).toBeLessThan(4096);
  });
});
