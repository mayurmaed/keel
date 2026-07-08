import { describe, it, expect } from "vitest";
import {
  putApp, getApp, listDeploys, ensureWebhookSecret, setEnvVar, listEnvVars, newDeployId,
  type AppRecord,
} from "../src/aws/registry";

function fake(answers: (cmd: string, input: any) => unknown) {
  const calls: Array<{ cmd: string; input: any }> = [];
  const send = async (c: any) => {
    calls.push({ cmd: c.constructor.name, input: c.input });
    return answers(c.constructor.name, c.input) ?? {};
  };
  return { calls, deps: { ddb: { send }, ssm: { send }, table: "keel" } };
}

const app: AppRecord = {
  name: "web", repo: "https://github.com/me/web", branch: "main",
  port: 3000, cpu: 256, memory: 512, healthPath: "/", createdAt: "2026-07-08T00:00:00Z",
};

describe("registry", () => {
  it("putApp writes PK=APP#name SK=META", async () => {
    const { calls, deps } = fake(() => ({}));
    await putApp(deps, app);
    expect(calls[0].cmd).toBe("PutCommand");
    expect(calls[0].input.Item).toMatchObject({ PK: "APP#web", SK: "META", port: 3000 });
  });

  it("getApp returns undefined for missing apps", async () => {
    const { deps } = fake(() => ({}));
    expect(await getApp(deps, "nope")).toBeUndefined();
  });

  it("listDeploys queries newest-first with a limit", async () => {
    const { calls, deps } = fake((cmd) =>
      cmd === "QueryCommand" ? { Items: [{ PK: "APP#web", SK: "DEPLOY#20260708T000000Z", status: "live" }] } : {},
    );
    const deploys = await listDeploys(deps, "web", 5);
    expect(calls[0].input.ScanIndexForward).toBe(false);
    expect(calls[0].input.Limit).toBe(5);
    expect(deploys[0].id).toBe("20260708T000000Z");
    expect(deploys[0].status).toBe("live");
  });

  it("ensureWebhookSecret returns the existing secret", async () => {
    const { deps } = fake((cmd) =>
      cmd === "GetParameterCommand" ? { Parameter: { Value: "existing" } } : {},
    );
    expect(await ensureWebhookSecret(deps, "web")).toBe("existing");
  });

  it("ensureWebhookSecret creates a 64-hex secret when missing", async () => {
    const { calls, deps } = fake((cmd) => {
      if (cmd === "GetParameterCommand") throw Object.assign(new Error("x"), { name: "ParameterNotFound" });
      return {};
    });
    const secret = await ensureWebhookSecret(deps, "web");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const put = calls.find((c) => c.cmd === "PutParameterCommand")!;
    expect(put.input.Name).toBe("/keel/web/webhook-secret");
    expect(put.input.Type).toBe("SecureString");
  });

  it("env vars round-trip through SSM paths", async () => {
    const { calls, deps } = fake((cmd) =>
      cmd === "GetParametersByPathCommand"
        ? { Parameters: [{ Name: "/keel/web/env/API_KEY", Value: "abc" }] }
        : {},
    );
    await setEnvVar(deps, "web", "API_KEY", "abc");
    expect(calls[0].input).toMatchObject({ Name: "/keel/web/env/API_KEY", Value: "abc", Type: "SecureString", Overwrite: true });
    expect(await listEnvVars(deps, "web")).toEqual({ API_KEY: "abc" });
  });

  it("listEnvVars paginates through SSM results", async () => {
    let callCount = 0;
    const { calls, deps } = fake((cmd) => {
      if (cmd === "GetParametersByPathCommand") {
        callCount++;
        if (callCount === 1) return { Parameters: [{ Name: "/keel/web/env/A", Value: "1" }], NextToken: "t1" };
        return { Parameters: [{ Name: "/keel/web/env/B", Value: "2" }] };
      }
      return {};
    });
    const result = await listEnvVars(deps, "web");
    expect(result).toEqual({ A: "1", B: "2" });
    expect(calls[1].input.NextToken).toBe("t1");
  });

  it("newDeployId matches the Lambda's format", () => {
    expect(newDeployId()).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
