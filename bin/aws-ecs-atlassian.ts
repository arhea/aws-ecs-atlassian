#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsEcsAtlassianStack } from '../lib/aws-ecs-atlassian-stack';

const app = new cdk.App();
new AwsEcsAtlassianStack(app, 'AwsEcsAtlassianStack');
