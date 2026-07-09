import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  type Capability,
} from "@aws-sdk/client-cloudformation";

type Cfn = Pick<CloudFormationClient, "send">;

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

export async function deployStack(
  cfn: Cfn,
  name: string,
  templateBody: string,
  params: Record<string, string>,
): Promise<Record<string, string>> {
  const Parameters = Object.entries(params).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v }));
  const common = { StackName: name, TemplateBody: templateBody, Parameters, Capabilities: ["CAPABILITY_NAMED_IAM"] as Capability[] };
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
    await waitUntilStackCreateComplete({ client, maxWaitTime: 1800 }, { StackName: name });
  }
  return stackOutputs(cfn, name);
}
