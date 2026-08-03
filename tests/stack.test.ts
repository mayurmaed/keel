import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { deployStack, projectTags, SHARED_TAGS } from "../src/aws/stack";

const { waitUntilStackCreateComplete, waitUntilStackDeleteComplete } = vi.hoisted(() => ({
  waitUntilStackCreateComplete: vi.fn(),
  waitUntilStackDeleteComplete: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudformation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cloudformation")>();
  return { ...actual, waitUntilStackCreateComplete, waitUntilStackDeleteComplete };
});

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it("retries one fresh create after the configured transient failure is deleted", async () => {
    waitUntilStackCreateComplete.mockRejectedValueOnce(new Error("create failed")).mockResolvedValueOnce({});
    waitUntilStackDeleteComplete.mockResolvedValueOnce({});
    const calls: string[] = [];
    const cfn = {
      send: async (c: any) => {
        const cmd = c.constructor.name;
        calls.push(cmd);
        if (cmd === "DescribeStacksCommand") {
          if (!calls.includes("CreateStackCommand")) {
            throw Object.assign(new Error("Stack does not exist"), { name: "ValidationError" });
          }
          return { Stacks: [{ Outputs: [{ OutputKey: "TableName", OutputValue: "keel" }] }] };
        }
        if (cmd === "DescribeStackEventsCommand") {
          return { StackEvents: [{ ResourceStatusReason: "transient KMS grant failure" }] };
        }
        return {};
      },
    } as any;

    const out = await deployStack(cfn, "keel-control-plane", "tpl", {}, {
      retryCreateFailure: (reasons) => reasons.includes("transient KMS grant failure"),
    });

    expect(calls.filter((call) => call === "CreateStackCommand")).toHaveLength(2);
    expect(waitUntilStackDeleteComplete).toHaveBeenCalledOnce();
    expect(out.TableName).toBe("keel");
  });

  it("does not retry create failures that the caller does not classify as transient", async () => {
    waitUntilStackCreateComplete.mockRejectedValueOnce(new Error("create failed"));
    const { calls, cfn } = fakeCfn({ exists: false });

    await expect(deployStack(cfn, "keel-control-plane", "tpl", {}, { retryCreateFailure: () => false }))
      .rejects.toThrow("create failed");
    expect(calls.filter((call) => call === "CreateStackCommand")).toHaveLength(1);
    expect(waitUntilStackDeleteComplete).not.toHaveBeenCalled();
  });

  it("rejects instead of swallowing a transient DescribeStacks error into a create attempt", async () => {
    const calls: string[] = [];
    const cfn = {
      send: async (c: any) => {
        const cmd = c.constructor.name;
        calls.push(cmd);
        if (cmd === "DescribeStacksCommand") {
          throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        }
        return {};
      },
    } as any;
    await expect(deployStack(cfn, "keel-control-plane", "tpl", {})).rejects.toThrow(/Rate exceeded/);
    expect(calls).not.toContain("CreateStackCommand");
  });

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

describe("stack tags (#17)", () => {
  function capturingCfn(exists: boolean) {
    const inputs: Record<string, any>[] = [];
    const calls: string[] = [];
    return {
      inputs,
      cfn: {
        send: async (c: any) => {
          const cmd = c.constructor.name;
          calls.push(cmd);
          if (cmd === "DescribeStacksCommand") {
            if (!exists && !calls.includes("CreateStackCommand")) {
              throw Object.assign(new Error("Stack does not exist"), { name: "ValidationError" });
            }
            return { Stacks: [{ Outputs: [{ OutputKey: "TableName", OutputValue: "keel" }] }] };
          }
          if (cmd === "CreateStackCommand" || cmd === "UpdateStackCommand") inputs.push(c.input);
          // Tags are captured above before this short-circuits the update waiter.
          if (cmd === "UpdateStackCommand") throw new Error("No updates are to be performed.");
          return {};
        },
      } as any,
    };
  }

  it("sends project tags on create so CloudFormation propagates them to every resource", async () => {
    const { inputs, cfn } = capturingCfn(false);
    await deployStack(cfn, "keel-app-web", "tpl", {}, { tags: projectTags("acme") });
    expect(inputs[0].Tags).toEqual([
      { Key: "keel:managed", Value: "true" },
      { Key: "keel:project", Value: "acme" },
    ]);
  });

  it("tags updates too, so existing stacks pick the tags up on next deploy", async () => {
    const { inputs, cfn } = capturingCfn(true);
    await deployStack(cfn, "keel-app-web", "tpl", {}, { tags: projectTags("acme") });
    expect(inputs[0].Tags).toContainEqual({ Key: "keel:project", Value: "acme" });
  });

  it("tags shared stacks as keel-managed without a project attribution", async () => {
    const { inputs, cfn } = capturingCfn(false);
    await deployStack(cfn, "keel-ingress", "tpl", {}, { tags: SHARED_TAGS });
    expect(inputs[0].Tags).toEqual([{ Key: "keel:managed", Value: "true" }]);
    expect(inputs[0].Tags.map((t: any) => t.Key)).not.toContain("keel:project");
  });

  it("sends an empty tag list when no tags are configured", async () => {
    const { inputs, cfn } = capturingCfn(false);
    await deployStack(cfn, "keel-ingress", "tpl", {});
    expect(inputs[0].Tags).toEqual([]);
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

  it("empties the shared ECR repository when the control plane is deleted", () => {
    expect(tpl).toMatch(/Repo:\n    Type: AWS::ECR::Repository\n    Properties:\n      RepositoryName: keel-apps\n      EmptyOnDelete: true/);
  });
});
