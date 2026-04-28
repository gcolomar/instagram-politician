# Instagram Content Audit

Analyze your Instagram data export (posts, comments, and DMs) to identify sensitive content you may want to review or delete — using AWS Bedrock and Claude AI.

## Architecture

```
Browser (S3 + CloudFront)
        │
        │  POST /analyze
        ▼
   API Gateway  ──────────►  Lambda (Python)  ──────────►  Bedrock (Claude Haiku)
   (throttling)                                             content analysis
```

**AWS services used:** S3 · CloudFront · API Gateway · Lambda · Bedrock · IAM · CDK

## How it works

1. User downloads their Instagram data export as a ZIP file
2. Uploads the ZIP directly to the web app
3. Content is grouped by type (posts, comments, DMs per conversation)
4. Each group is analyzed in real-time via Bedrock — results appear as they come in
5. Final report shows flagged content by severity: Critical / Medium / Low

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- AWS Bedrock access enabled in your region for `anthropic.claude-haiku-4-5-20251001-v1:0`
- CDK CLI: `npm install -g aws-cdk`

## Deploy

```bash
# 1. Install CDK dependencies
cd infrastructure
npm install

# 2. Bootstrap CDK (first time only)
cdk bootstrap

# 3. Deploy
cdk deploy
```

CDK will output two URLs:
```
InstagramModeratorStack.CloudFrontURL = https://xxxx.cloudfront.net
InstagramModeratorStack.ApiGatewayURL = https://xxxx.execute-api.us-east-1.amazonaws.com/prod/
```

```bash
# 4. Set the API URL in the frontend config
# Edit frontend/config.js and replace YOUR_API_GATEWAY_URL with the ApiGatewayURL output

# 5. Re-deploy to push the updated config to S3
cdk deploy
```

Open the CloudFrontURL in your browser — the app is live.

## Tear down

```bash
cdk destroy
```

Removes all AWS resources.

## Getting your Instagram data

1. Instagram → Settings → **Your activity on Instagram**
2. Select **Download your information**
3. Choose **JSON** format and request the download
4. Instagram will email you a link (can take up to 48h)
5. Download and upload the `.zip` directly to the app — no need to unzip

## Cost estimate

Claude Haiku on Bedrock costs ~$0.00025 per 1K input tokens.  
A typical export with 5,000 items costs under **$1**.

---

Built with [Claude Code](https://claude.ai/claude-code)
