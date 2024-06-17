const { WebClient } = require('@slack/web-api');
const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('redis');

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;
const deployId = uuidv4();
const service = process.env.SERVICE;
const environment = process.env.ENVIRONMENT;
const githubBuildId = process.env.GITHUB_RUN_ID;
const author = process.env.GITHUB_ACTOR;
const commit = process.env.GITHUB_SHA;
const runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${githubBuildId}`;
const channel = process.env.SLACK_CHANNEL;
const slackToken = process.env.SLACK_TOKEN;
const dynamoDbTable = process.env.DYNAMODB_TABLE;
const region = process.env.AWS_REGION;
const awsAccessKeyId = process.env.AWS_ACCESS_KEY;
const awsSecretAccessKey = process.env.AWS_SECRET_KEY;

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
    socket: {
         tls: true,
    }
});

subscriber.on('connect', () => console.log('Redis client connected.'));
subscriber.on('error', (err) => console.error('Redis Client Error', err));
subscriber.on('end', () => console.log('Redis client disconnected.'));


async function init() {
    try {
        await subscriber.connect();
        await initSession(deployId, service, environment, githubBuildId, author, commit, runUrl);
        await setApprovalStatus(deployId, 'false');
        await setRejectedStatus(deployId, 'false');
        await slackClient.chat.postMessage({
            channel: channel,
            text: "Deployment Approval",
            blocks: [divider, messageHeader, initialMsg(deployId), contextInfo(author, service, commit, githubBuildId, environment, runUrl)]
        });
    } catch (error) {
        console.error(`An error occurred during initialization: ${error}`);
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


async function setApprovalStatus(deployId, status) {
    const params = {
        TableName: dynamoDbTable,
        Key: {
            deploy_id: { S: deployId }
        },
        UpdateExpression: 'SET approved = :s',
        ExpressionAttributeValues: {
            ':s': { S: status }
        },
        ReturnValues: 'UPDATED_NEW'
    };
    await dynamoDbClient.send(new UpdateItemCommand(params));
}


async function setRejectedStatus(deployId, status) {
    const params = {
        TableName: dynamoDbTable,
        Key: {
            deploy_id: { S: deployId }
        },
        UpdateExpression: 'SET rejected = :s',
        ExpressionAttributeValues: {
            ':s': { S: status }
        },
        ReturnValues: 'UPDATED_NEW'
    };
    await dynamoDbClient.send(new UpdateItemCommand(params));
}


async function subscribeToDeployment() {
    console.log(`⏳ Subscribing to channel for Deployment ID: ${deployId}`);
    subscriber.subscribe(deployId, (message) => {
        processMessage(JSON.parse(message));
    });
}

async function processMessage(message) {
    if (message.deployment_id === deployId) {
        console.log("⏳ Processing message with matching deployment ID:", message.deployment_id);
        if (message.approval_status === "true") {
            console.log("✅ Deployment approved.");
            process.exit(0);
        } else if (message.approval_status === "false") {
            console.log("🚫 Deployment rejected.");
            process.exit(1);
        }
    } else {
        console.log("🚨 Deployment ID does not match. Ignored message with ID:", message.deployment_id);
    }
}



function initialMsg(deployId) {
    return {
        type: "actions",
        elements: [
            {
                type: "button",
                style: "primary",
                text: { type: "plain_text", text: "1st Approver" },
                value: `${deployId}`,
                action_id: "first_approver"
            },
            {
                type: "button",
                style: "primary",
                text: { type: "plain_text", text: "2nd Approver" },
                value: `${deployId}`,
                action_id: "second_approver"
            },
            {
                type: "button",
                style: "danger",
                text: { type: "plain_text", text: "Reject" },
                value: `${deployId}`,
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

const messageHeader = {
    type: "section",
    text: { type: "mrkdwn", text: "*Deployment Approval*" }
};


init().then(subscribeToDeployment).catch(error => {
    console.error('Error during initialization or subscription:', error);
});