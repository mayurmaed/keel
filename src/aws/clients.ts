import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { STSClient } from "@aws-sdk/client-sts";
import { Route53Client } from "@aws-sdk/client-route-53";

export interface AwsClients {
  cfn: CloudFormationClient;
  ddb: DynamoDBDocumentClient;
  ssm: SSMClient;
  codebuild: CodeBuildClient;
  ecs: ECSClient;
  ec2: EC2Client;
  logs: CloudWatchLogsClient;
  sts: STSClient;
  route53: Route53Client;
}

export function makeClients(region: string): AwsClients {
  return {
    cfn: new CloudFormationClient({ region }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    ssm: new SSMClient({ region }),
    codebuild: new CodeBuildClient({ region }),
    ecs: new ECSClient({ region }),
    ec2: new EC2Client({ region }),
    logs: new CloudWatchLogsClient({ region }),
    sts: new STSClient({ region }),
    route53: new Route53Client({ region }),
  };
}
