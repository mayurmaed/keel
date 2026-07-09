import { readFileSync } from "node:fs";
import { input } from "@inquirer/prompts";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { makeClients, type AwsClients } from "../aws/clients.js";
import { GLOBAL_CONFIG_PATH, writeGlobalConfig } from "../aws/globalconfig.js";
import { deployStack } from "../aws/stack.js";

export interface SetupOpts {
  region?: string;
  domain?: string;
  githubToken?: string;
  profile?: string;
  yes?: boolean;
}

const STACK = "keel-control-plane";

export async function setupCommand(
  opts: SetupOpts,
  io: { clients?: AwsClients; configPath?: string } = {},
): Promise<void> {
  if (opts.profile) process.env.AWS_PROFILE = opts.profile;
  const region =
    opts.region ?? process.env.AWS_REGION ??
    (opts.yes ? "ap-south-1" : await input({ message: "AWS region", default: "ap-south-1" }));
  const clients = io.clients ?? makeClients(region);

  try {
    await clients.sts.send(new GetCallerIdentityCommand({}));
  } catch {
    throw new Error(
      "AWS credentials not found or invalid. Run `aws configure` (or set AWS_PROFILE) and re-run `keel setup`.",
    );
  }

  const vpcs = await clients.ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }));
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error("no default VPC found in this region — create one (VPC console → Create default VPC) and re-run");
  const subnets = await clients.ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
  const subnetIds = (subnets.Subnets ?? []).map((s) => s.SubnetId!).slice(0, 3);

  const template = readFileSync(new URL("../../infra/control-plane.yaml", import.meta.url), "utf8");
  const webhookCode = readFileSync(new URL("../../infra/webhook-handler.cjs", import.meta.url), "utf8");
  console.log(`deploying stack ${STACK} to ${region} (first run takes ~3 minutes)…`);
  const outputs = await deployStack(clients.cfn, STACK, template, { WebhookCode: webhookCode });

  if (opts.githubToken) {
    await clients.ssm.send(new PutParameterCommand({
      Name: "/keel/github-token", Value: opts.githubToken, Type: "SecureString", Overwrite: true,
    }));
  }

  writeGlobalConfig(
    {
      region,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.domain ? { baseDomain: opts.domain } : {}),
      githubTokenStored: Boolean(opts.githubToken),
      controlPlane: {
        stackName: STACK,
        tableName: outputs.TableName,
        clusterName: outputs.ClusterName,
        ecrRepoUri: outputs.EcrRepoUri,
        buildProject: outputs.BuildProject,
        webhookBase: outputs.WebhookBase,
        taskExecRoleArn: outputs.TaskExecRoleArn,
        logGroup: outputs.LogGroup,
        vpcId,
        subnetIds,
      },
    },
    io.configPath ?? GLOBAL_CONFIG_PATH,
  );

  console.log(`keel is set up. webhook base: ${outputs.WebhookBase}`);
}
