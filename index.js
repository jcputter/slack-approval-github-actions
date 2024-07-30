const core = require('@actions/core');
const { WebClient } = require('@slack/web-api');
const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('redis');

const redisHost = core.getInput('REDIS_HOST') || 'localhost';
const redisPort = core.getInput('REDIS_PORT') || 6379;
const deployId = uuidv4();
const service = core.getInput('SERVICE', { required: true });
const environment = core.getInput('ENVIRONMENT', { required: true });
const githubBuildId = core.getInput('GITHUB_RUN_ID', { required: true });
const author = core.getInput('GITHUB_AUTHOR', { required: true });
const commit = core.getInput('GITHUB_SHA', { required: true });
const channel = core.getInput('SLACK_CHANNEL', { required: true });
const slackToken = core.getInput('SLACK_TOKEN', { required: true });
const dynamoDbTable = core.getInput('DYNAMODB_TABLE', { required: true });
const region = core.getInput('AWS_REGION', { required: true });
const awsAccessKeyId = core.getInput('AWS_ACCESS_KEY', { required: true });
const awsSecretAccessKey = core.getInput('AWS_SECRET_KEY', { required: true });
const githubRepository = core.getInput('GITHUB_REPOSITORY', { required: true });

const runUrl = `https://github.com/${githubRepository}/actions/runs/${githubBuildId}`;

const slackClient = new WebClient(slackToken);

const dynamoDbClient = new DynamoDBClient({
  region,
  credentials: {
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey
  }
});

const subscriber = createClient({
  url: `redis://${redisHost}:${redisPort}`,
  socket: { tls: true }
});

subscriber.on('connect', () => core.info('Redis client connected.'));
subscriber.on('error', (err) => core.error('Redis Client Error', err));
subscriber.on('end', () => core.info('Redis client disconnected.'));

async function init() {
  try {
    await subscriber.connect();
    await initSession(deployId, service, environment, githubBuildId, author, commit, runUrl);
    await setStatus(deployId, 'approved', 'false');
    await setStatus(deployId, 'rejected', 'false');
    await sendSlackMessage();
    await subscribeToDeployment();
  } catch (error) {
    core.setFailed(`🚫 An error occurred during initialization: ${error.message}`);
    process.exit(1);
  }
}

async function initSession(deployId, service, environment, githubBuildId, author, commit, runUrl) {
  const currentTime = new Date().toISOString();
  const params = {
    TableName: dynamoDbTable,
    Item: {
      timestamp: { S: currentTime },
      environment: { S: environment },
      deploy_id: { S: deployId },
      run_url: { S: runUrl },
      first_approver: { S: '' },
      second_approver: { S: '' },
      service: { S: service },
      github_build_id: { S: githubBuildId },
      author: { S: author },
      commit: { S: commit },
      approved: { S: '' },
      rejected: { S: '' }
    }
  };
  await dynamoDbClient.send(new PutItemCommand(params));
}

async function setStatus(deployId, field, status) {
  const params = {
    TableName: dynamoDbTable,
    Key: { deploy_id: { S: deployId } },
    UpdateExpression: `SET ${field} = :s`,
    ExpressionAttributeValues: { ':s': { S: status } },
    ReturnValues: 'UPDATED_NEW'
  };
  await dynamoDbClient.send(new UpdateItemCommand(params));
}

async function subscribeToDeployment() {
  core.info(`⏳ Subscribing to channel for Deployment ID: ${deployId}`);
  await subscriber.subscribe(deployId, async (message) => {
    await processMessage(JSON.parse(message));
  });
}

async function processMessage(message) {
  if (message.deployment_id === deployId) {
    core.info("⏳ Processing message with matching deployment ID:", message.deployment_id);
    if (message.approval_status === "true") {
      core.info("✅ Deployment approved.");
    } else if (message.approval_status === "false") {
      core.setFailed("🚫 Deployment was rejected.");
      process.exit(1);
    }
  } else {
    core.info("🚨 Deployment ID does not match. Ignored message with ID:", message.deployment_id);
  }
}

async function sendSlackMessage() {
  const blocks = [
    divider,
    messageHeader,
    initialMsg(deployId),
    contextInfo(author, service, commit, githubBuildId, environment, runUrl)
  ];
  await slackClient.chat.postMessage({
    channel: channel,
    text: "Deployment Approval",
    blocks
  });
}

function initialMsg(deployId) {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "1st Approver" },
        value: deployId,
        action_id: "first_approver"
      },
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "2nd Approver" },
        value: deployId,
        action_id: "second_approver"
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: "Reject" },
        value: deployId,
        action_id: "reject_1"
      }
    ]
  };
}

function contextInfo(author, service, commit, buildId, environment, runUrl) {
  return {
    type: "context",
    elements: [
      { type: "plain_text", text: `Actor: ${author}` },
      { type: "plain_text", text: `Service: ${service}` },
      { type: "plain_text", text: `Commit: ${commit}` },
      { type: "plain_text", text: `Build ID: ${buildId}` },
      { type: "plain_text", text: `Environment: ${environment}` },
      { type: "mrkdwn", text: `Build: <${runUrl}|Workflow Run>` }
    ]
  };
}

const divider = { type: "divider", block_id: "divider1" };
const messageHeader = { type: "section", text: { type: "mrkdwn", text: "*Deployment Approval*" } };

init().catch(error => {
  core.setFailed(`🚫 Error during initialization or subscription: ${error.message}`);
  process.exit(1);
});
