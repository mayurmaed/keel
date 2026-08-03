import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
  type Capability,
} from "@aws-sdk/client-cloudformation";

type Cfn = Pick<CloudFormationClient, "send">;

export interface DeployStackOptions {
  retryCreateFailure?: (reasons: string[]) => boolean;
  /** Stack-level tags. CloudFormation propagates these to every taggable resource
   *  in the stack, so this is the only place tagging needs to happen. */
  tags?: Record<string, string>;
}

/** Tags for a project-scoped stack (app, db, auth) — `keel:project` drives
 *  per-project cost attribution in Cost Explorer. */
export function projectTags(project: string): Record<string, string> {
  return { "keel:managed": "true", "keel:project": project };
}

/** Tags for stacks shared across every project (control plane, ingress). */
export const SHARED_TAGS: Record<string, string> = { "keel:managed": "true" };

export async function stackOutputs(cfn: Cfn, name: string): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  const outputs: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

async function stackExists(cfn: Cfn, name: string): Promise<boolean> {
  try {
    await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return true;
  } catch (e: any) {
    if (e?.name === "ValidationError" || /does not exist/i.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

async function stackFailureReasons(cfn: Cfn, name: string): Promise<string[]> {
  try {
    const events = await cfn.send(new DescribeStackEventsCommand({ StackName: name }));
    return (events.StackEvents ?? []).flatMap((event) => event.ResourceStatusReason ? [event.ResourceStatusReason] : []);
  } catch {
    return [];
  }
}

export async function deployStack(
  cfn: Cfn,
  name: string,
  templateBody: string,
  params: Record<string, string>,
  options: DeployStackOptions = {},
): Promise<Record<string, string>> {
  const Parameters = Object.entries(params).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v }));
  const Tags = Object.entries(options.tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
  const common = { StackName: name, TemplateBody: templateBody, Parameters, Tags, Capabilities: ["CAPABILITY_NAMED_IAM"] as Capability[] };
  const client = cfn as CloudFormationClient;
  if (await stackExists(cfn, name)) {
    try {
      await cfn.send(new UpdateStackCommand(common));
      await waitUntilStackUpdateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
    } catch (e) {
      if (!/No updates are to be performed/.test(String(e))) throw e;
    }
  } else {
    await cfn.send(new CreateStackCommand({ ...common, OnFailure: "DELETE" }));
    try {
      await waitUntilStackCreateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
    } catch (error) {
      if (!options.retryCreateFailure?.(await stackFailureReasons(cfn, name))) throw error;
      await waitUntilStackDeleteComplete({ client, maxWaitTime: 1800 }, { StackName: name });
      await cfn.send(new CreateStackCommand({ ...common, OnFailure: "DELETE" }));
      await waitUntilStackCreateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
    }
  }
  return stackOutputs(cfn, name);
}
