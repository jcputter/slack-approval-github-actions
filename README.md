# Deployment Approval Action

Github Action for deployment approvals using Slack.

**Prerequisites** 

- Github Runners that will have network access to your redis host
- Deployment of the backend (https://github.com/jcputter/slack-approval-lambda)

```
- name: Approval
  uses: jcputter/slack-approval-github-action@master
  env:
    SLACK_CHANNEL: change_channel_id
    SLACK_TOKEN: change_slack_token
    DYNAMODB_TABLE: change_table_name
    AWS_REGION: change_region
    SERVICE: change_service_name
    ENVIRONMENT: change_environment
    AWS_ACCESS_KEY: change_aws_access_key
    AWS_SECRET_KEY: change_aws_secret_key
    REDIS_HOST: change_redis_host
```
