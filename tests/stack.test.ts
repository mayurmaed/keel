import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deployStack } from "../src/aws/stack";

function fakeCfn(opts: { exists: boolean; noUpdates?: boolean }) {
  const calls: string[] = [];
  const stack = {
    StackName: "keel-control-plane",
    StackStatus: opts.exists ? "UPDATE_COMPLETE" : "CREATE_COMPLETE",
    Outputs: [{ OutputKey: "TableName", OutputValue: "keel" }],
  };
  return {
    calls,
    cfn: {
      send: async (c: any) => {
        const cmd = c.constructor.name;
        calls.push(cmd);
        if (cmd === "DescribeStacksCommand") {
          if (!opts.exists && !calls.includes("CreateStackCommand")) {
            throw Object.assign(new Error("Stack does not exist"), { name: "ValidationError" });
          }
          return { Stacks: [stack] };
        }
        if (cmd === "UpdateStackCommand" && opts.noUpdates) {
          throw new Error("No updates are to be performed.");
        }
        return {};
      },
    } as any,
  };
}

describe("deployStack", () => {
  it("creates when the stack does not exist and returns outputs", async () => {
    const { calls, cfn } = fakeCfn({ exists: false });
    const out = await deployStack(cfn, "keel-control-plane", "tpl", { WebhookCode: "x" });
    expect(calls).toContain("CreateStackCommand");
    expect(out.TableName).toBe("keel");
  });

  it("updates when the stack exists and tolerates no-op updates", async () => {
    const { calls, cfn } = fakeCfn({ exists: true, noUpdates: true });
    const out = await deployStack(cfn, "keel-control-plane", "tpl", {});
    expect(calls).toContain("UpdateStackCommand");
    expect(out.TableName).toBe("keel");
  });
});

describe("control-plane template", () => {
  const tpl = readFileSync("infra/control-plane.yaml", "utf8");
  it("declares the required outputs and the WebhookCode parameter", () => {
    for (const key of [
      "TableName", "ClusterName", "EcrRepoUri", "BuildProject",
      "WebhookBase", "TaskExecRoleArn", "LogGroup", "WebhookCode",
    ]) expect(tpl).toContain(key);
  });
});
