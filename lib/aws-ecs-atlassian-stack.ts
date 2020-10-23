import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import { BitBucketServer } from './components/bitbucket-server'
import { ContainerPipeline } from './components/container-pipeline'


export class AwsEcsAtlassianStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // create the vpc
    const vpc = new ec2.Vpc(this, 'VPC');

    // create the ecs cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsights: true
    });

    // create bitbucket container pipeline
    const bitbucketPipeline = new ContainerPipeline(this, 'BitbucketPipeline', {
      buildSpecPath: './containers/bitbucket/buildspec.yml',
      repositoryName: 'atlassian/bitbucket-server',
      githubOwner: 'arhea',
      githubRepo: 'aws-ecs-atlassian'
    });

    // create bitbucket server
    const bitbucket = new BitBucketServer(this, 'Bitbucket', {
      vpc,
      cluster,
      repository: bitbucketPipeline.repository,
      database: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MEDIUM)
      }
    });

  }
}
