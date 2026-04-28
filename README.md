# Instagram Content Audit

An AI-powered privacy tool that scans your Instagram data export — posts, comments, and direct messages — and surfaces content you may want to review or delete. Runs entirely on your own AWS account; no data is stored by the app.

## Architecture

```
Browser
  │  streaming ZIP parser (zip.js) — media never loaded into memory
  │
  ├─► CloudFront (CDN + HTTPS)
  │       │  Lambda@Edge — cookie-based auth on every request
  │       ▼
  │      S3  (static frontend)
  │
  └─► API Gateway (throttle: 5 req/s · API key required)
          │
          ├─► POST /login   → Lambda (Python) — validates password, sets session cookie
          │
          └─► POST /analyze → Lambda (Python) → Bedrock (Claude Haiku 4.5)
                                   │
                                   ├─ Batch mode    — posts & comments (15 items/call)
                                   └─ Conversation  — DMs (1 000-message sliding window + rolling summary)
```

**AWS services:** S3 · CloudFront · Lambda · Lambda@Edge · API Gateway · Bedrock · IAM · CloudWatch · X-Ray · CDK

## Features

- **Streaming ZIP parser** — reads only JSON files from the export; photos and videos are never loaded into memory
- **Three content types** — posts & reels, comments, direct messages analyzed separately
- **Owner-only flagging** — the app detects which account is yours and only flags your own messages, using the full conversation as context
- **Unanswered contact detection** — flags conversations where you sent repeated messages with no reply (high: 5+, medium: 3–4, low: 2)
- **Live results** — flagged items appear in real-time sorted by severity as analysis runs; no waiting for the full scan to finish
- **5× parallel DM processing** — conversations are analyzed 5 at a time instead of sequentially
- **Completion notification** — browser notification + sound when the scan finishes (works while the tab is in the background)
- **Export** — download results as PDF (generated locally, nothing sent externally) or CSV (opens in Excel with full UTF-8 support)
- **Session cache** — results are saved to localStorage for 48 hours; refreshing the page restores the report instantly without re-running the analysis
- **Login wall** — Lambda@Edge enforces cookie authentication on every CloudFront request; the session token doubles as the API key and is never stored in any source file
- **Observability** — X-Ray tracing on both Lambdas; CloudWatch alarm fires if the analyzer logs 5+ errors in 5 minutes

## Severity levels

| Level | Meaning |
|---|---|
| **Critical** | Threats, aggressive language, highly sensitive personal data, very insistent unanswered contact (5+ messages) |
| **Medium** | Offensive content, private third-party information, 3–4 unanswered messages |
| **Low** | Mildly embarrassing content, double-texts (2 unanswered messages) |

## Deploy

### Prerequisites

- Node.js 18+
- AWS CLI configured with a profile that has AdministratorAccess
- AWS CDK CLI: `npm install -g aws-cdk`
- Bedrock model access enabled for `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-1`

### First deploy

```bash
cd infrastructure
npm install

# Bootstrap CDK (once per AWS account/region)
AWS_PROFILE=your-profile cdk bootstrap --context edgePassword=YOUR_PASSWORD

# Deploy
AWS_PROFILE=your-profile cdk deploy --context edgePassword=YOUR_PASSWORD
```

CDK outputs:
```
InstagramModeratorStack.CloudFrontURL  = https://xxxx.cloudfront.net
InstagramModeratorStack.ApiGatewayURL  = https://xxxx.execute-api.us-east-1.amazonaws.com/prod/
```

Open the CloudFront URL, enter your password, and the app is live.

> **Note:** `edgePassword` is the password you'll use to log in. It is never written to any file — it is only passed as a CLI argument and used at synth time to derive a session token.

### Subsequent deploys (after code changes)

```bash
AWS_PROFILE=your-profile cdk deploy --context edgePassword=YOUR_PASSWORD
```

CDK detects what changed and only updates those resources.

### Tear down

```bash
AWS_PROFILE=your-profile cdk destroy --context edgePassword=YOUR_PASSWORD
```

Removes all AWS resources. S3 bucket and its contents are deleted automatically.

## Getting your Instagram data

1. Instagram → **Settings** → **Your activity on Instagram** → **Download your information**
2. Select **JSON** format and request the download
3. Instagram will email you a link (up to 48 hours)
4. Upload the `.zip` directly to the app — no need to unzip

## Cost estimate

All costs are in your own AWS account. Approximate figures for a typical personal account:

| Component | Cost |
|---|---|
| Bedrock — Claude Haiku 4.5 | ~$0.25 / 1M input tokens · ~$1.25 / 1M output tokens |
| Lambda | First 1M requests/month free |
| API Gateway | First 1M calls/month free |
| CloudFront + S3 | Fractions of a cent per request |
| Lambda@Edge | First 1M requests/month free |
| CloudWatch alarm | $0.10 / alarm / month |

A typical personal export (150 000 DM messages + 500 comments) costs **under $2** for a full scan.
