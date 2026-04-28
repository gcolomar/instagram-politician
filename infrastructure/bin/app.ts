#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InstagramModeratorStack } from '../lib/instagram-moderator-stack';

const app = new cdk.App();
new InstagramModeratorStack(app, 'InstagramModeratorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
