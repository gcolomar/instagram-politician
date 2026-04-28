import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import * as path from 'path';
import * as crypto from 'crypto';

export class InstagramModeratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const edgePassword = this.node.tryGetContext('edgePassword');
    if (!edgePassword) throw new Error('Required: cdk deploy --context edgePassword=<value>');

    // Session token derived from the password — embedded in both edge Lambda and login Lambda
    const sessionToken = crypto.createHmac('sha256', edgePassword).update('igaudit-session').digest('hex');

    // Lambda@Edge: runs at CloudFront on every viewer request
    //   - /login.html and /login-config.js are always served (no auth needed to reach the login page)
    //   - everything else requires a valid igaudit_session cookie
    const edgeAuth = new cloudfront.experimental.EdgeFunction(this, 'EdgeAuth', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const EXPECTED = ${JSON.stringify(sessionToken)};
        const COOKIE   = 'igaudit_session';
        const PUBLIC   = new Set(['/login.html', '/login-config.js']);

        exports.handler = async (event) => {
          const request = event.Records[0].cf.request;

          if (PUBLIC.has(request.uri)) return request;

          const raw   = (request.headers['cookie'] || [])[0]?.value || '';
          const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
          const token = match ? match.slice(COOKIE.length + 1) : '';

          if (token === EXPECTED) return request;

          return {
            status: '302',
            statusDescription: 'Found',
            headers: { location: [{ key: 'Location', value: '/login.html' }] },
            body: '',
          };
        };
      `),
    });

    // S3 bucket for the static frontend
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution — edge auth on every viewer request
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        edgeLambdas: [
          {
            functionVersion: edgeAuth.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: 'index.html',
    });

    // Login Lambda — validates the password and returns the session token
    const loginLambda = new lambda.Function(this, 'LoginLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/login')),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        PASSWORD:           edgePassword,
        SESSION_TOKEN:      sessionToken,
        CLOUDFRONT_ORIGIN:  `https://${distribution.distributionDomainName}`,
      },
    });

    // Analyzer Lambda — calls Bedrock to flag Instagram content
    const analyzerLambda = new lambda.Function(this, 'AnalyzerLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Alarm: flag if the analyzer starts throwing errors (5 errors in 5 min = something is wrong)
    new cloudwatch.Alarm(this, 'AnalyzerErrorAlarm', {
      metric: analyzerLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: 'Analyzer Lambda errors — check X-Ray for traces',
    });

    analyzerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:*:*:inference-profile/*`,
      ],
    }));

    // API Gateway
    const api = new apigateway.RestApi(this, 'AnalyzerApi', {
      restApiName: 'instagram-moderator-api',
      defaultCorsPreflightOptions: {
        allowOrigins: [`https://${distribution.distributionDomainName}`],
        allowMethods: ['POST'],
        allowHeaders: ['Content-Type', 'x-api-key'],
      },
      deployOptions: {
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
    });

    // POST /login — public, no API key required
    api.root.addResource('login').addMethod('POST', new apigateway.LambdaIntegration(loginLambda));

    // POST /analyze — requires API key
    const analyzeResource = api.root.addResource('analyze');
    analyzeResource.addMethod('POST', new apigateway.LambdaIntegration(analyzerLambda), {
      apiKeyRequired: true,
    });

    // The session token doubles as the API key — never stored in any frontend file
    const apiKey = api.addApiKey('DemoApiKey', {
      apiKeyName: 'instagram-moderator-key',
      value: sessionToken,
    });

    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: 'DemoUsagePlan',
      throttle: { rateLimit: 5, burstLimit: 10 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // Deploy frontend files to S3 — config files are generated with live values
    new s3deploy.BucketDeployment(this, 'FrontendDeployment', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../../frontend')),
        s3deploy.Source.data('config.js',      `const API_URL = '${api.url}analyze';\n`),
        s3deploy.Source.data('login-config.js', `const LOGIN_URL = '${api.url}login';\n`),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Frontend URL',
    });

    new cdk.CfnOutput(this, 'ApiGatewayURL', {
      value: api.url,
      description: 'Paste into frontend/config.js (API_URL) and frontend/login-config.js (LOGIN_URL)',
    });
  }
}
