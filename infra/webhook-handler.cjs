// keel webhook: verify GitHub HMAC, record deploy, start CodeBuild. CJS: CFN ZipFile => index.js
"use strict";
const { createHmac, timingSafeEqual } = require("node:crypto");
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");

const makeHandler = (d) => async (evt) => {
  const T = process.env.TABLE, P = process.env.PROJECT;
  const app = evt.pathParameters && evt.pathParameters.app;
  const sig = evt.headers && evt.headers["x-hub-signature-256"];
  if (!app || !sig) return { statusCode: 400, body: "bad request" };
  const body = evt.isBase64Encoded ? Buffer.from(evt.body || "", "base64") : Buffer.from(evt.body || "");
  const rec = await d.ddb.send(new GetItemCommand({ TableName: T, Key: { PK: { S: "APP#" + app }, SK: { S: "META" } } }));
  if (!rec.Item) return { statusCode: 204 };
  const sec = (await d.ssm.send(new GetParameterCommand({ Name: "/keel/" + app + "/webhook-secret", WithDecryption: true }))).Parameter.Value;
  const want = "sha256=" + createHmac("sha256", sec).update(body).digest("hex");
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) {
    return { statusCode: 401, body: "bad signature" };
  }
  const push = JSON.parse(body.toString());
  const branch = rec.Item.branch.S;
  if (push.ref !== "refs/heads/" + branch) return { statusCode: 204 };
  const id = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  await d.ddb.send(new PutItemCommand({ TableName: T, Item: {
    PK: { S: "APP#" + app }, SK: { S: "DEPLOY#" + id },
    status: { S: "queued" }, commit: { S: push.after || "" }, updatedAt: { S: new Date().toISOString() },
  } }));
  const ev = (n, v) => ({ name: n, value: String(v), type: "PLAINTEXT" });
  await d.cb.send(new StartBuildCommand({ projectName: P, environmentVariablesOverride: [
    ev("APP", app), ev("REPO_URL", rec.Item.repo.S), ev("BRANCH", branch),
    ev("PORT", rec.Item.port.N), ev("APP_DIR", (rec.Item.dir && rec.Item.dir.S) || ""),
    ev("CPU", (rec.Item.cpu && rec.Item.cpu.N) || "256"), ev("MEMORY", (rec.Item.memory && rec.Item.memory.N) || "512"),
    ev("DEPLOY_ID", id),
  ] }));
  return { statusCode: 202, body: "build started" };
};

exports.makeHandler = makeHandler;
exports.handler = makeHandler({
  ddb: new DynamoDBClient({}),
  ssm: new SSMClient({}),
  cb: new CodeBuildClient({}),
});
