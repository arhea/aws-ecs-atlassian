import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as ecr from '@aws-cdk/aws-ecr';
import * as codebuild from '@aws-cdk/aws-codebuild';

export interface ContainerPipelineProps {
  buildSpecPath: string;
  repositoryName: string;
  githubOwner: string;
  githubRepo: string;
}

export class ContainerPipeline extends cdk.Construct {

  repository: ecr.Repository;

  project: codebuild.Project;

  constructor(scope: cdk.Construct, id: string, props: ContainerPipelineProps) {
    super(scope, id);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    this.repository = new ecr.Repository(this, 'Repo', {
      repositoryName: props.repositoryName,
      imageScanOnPush: true
    });

    this.repository.grantPullPush(role);

    const gitHubSource = codebuild.Source.gitHub({
      owner: props.githubOwner,
      repo: props.githubRepo,
      webhook: true,
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('master'),
      ],
    });

    this.project = new codebuild.Project(this, 'Project', {
      role,
      source: gitHubSource,
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename(props.buildSpecPath),
      environmentVariables: {
        AWS_DEFAULT_REGION: {
          value: cdk.Stack.of(this).region
        },
        AWS_ACCOUNT_ID: {
          value: cdk.Stack.of(this).account
        },
        IMAGE_REPO_NAME: {
          value: this.repository.repositoryName
        },
        IMAGE_TAG: {
          value: 'latest'
        },
      },
    });

  }
}
