import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as efs from '@aws-cdk/aws-efs';
import * as rds from '@aws-cdk/aws-rds';
import * as secretsManager from '@aws-cdk/aws-secretsmanager'
import * as iam from '@aws-cdk/aws-iam';
import * as es from '@aws-cdk/aws-elasticsearch';
import * as ecr from '@aws-cdk/aws-ecr';

export interface BitBucketServerDatabaseProps {
  instanceType: ec2.InstanceType
}

export interface BitBucketServerProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  repository: ecr.IRepository;
  database: BitBucketServerDatabaseProps;
}

export class BitBucketServer extends cdk.Construct {

  loadBalancer: elbv2.ApplicationLoadBalancer;

  database: rds.DatabaseCluster;

  databasePassowrd: secretsManager.Secret;

  fileSystem: efs.FileSystem;

  elasticSearch: es.Domain;

  taskDefinition: ecs.FargateTaskDefinition;

  service: ecs.FargateService;

  constructor(scope: cdk.Construct, id: string, props: BitBucketServerProps) {
    super(scope, id);

    // create security groups
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket file system',
      allowAllOutbound: true
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket container',
      allowAllOutbound: true
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket load balancer',
      allowAllOutbound: true
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'allow access to the bitbucket container',
      allowAllOutbound: true
    });

    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'allow connections to the alb from the internet');
    taskSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(7990), 'allow connections from the alb to the container');
    dbSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(5432), 'allow connections from the container to the database');
    efsSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(2049), 'allow connections from the vpc to the file system');

    // create the database password
    this.databasePassowrd = new secretsManager.Secret(this, 'DatabasePassword', {
      generateSecretString: {
        passwordLength: 30,
        excludePunctuation: true,
        includeSpace: false
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // create the database
   this.database = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_11_7 }),
      defaultDatabaseName: 'bitbucket',
      credentials: rds.Credentials.fromUsername('bitbucket', {
        password: cdk.SecretValue.secretsManager(this.databasePassowrd.secretArn)
      }),
      instanceProps: {
        vpc: props.vpc,
        securityGroups: [dbSecurityGroup],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE,
        },
        instanceType: props.database.instanceType
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // create the filesystem
    this.fileSystem = new efs.FileSystem(this, 'Content', {
      vpc: props.vpc,
      encrypted: true,
      securityGroup: efsSecurityGroup,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // create the load balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'HttpLB', {
      vpc: props.vpc,
      securityGroup: albSecurityGroup,
      internetFacing: true
    });

    // create the fargate task
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskExecutionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'))
    this.databasePassowrd.grantRead(taskExecutionRole);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'bitbucket',
      executionRole: taskExecutionRole,
      memoryLimitMiB: 2048,
      cpu: 1024
    });

    const container = this.taskDefinition.addContainer('server', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'bitbucket-server' }),
      memoryLimitMiB: 2048,
      cpu: 1024,
      environment: {
        SERVER_PROXY_NAME: this.loadBalancer.loadBalancerDnsName,
        SERVER_PROXY_PORT: '80',
        SERVER_SCHEME: 'http',
        JVM_MAXIMUM_MEMORY: '2048m',
        JDBC_DRIVER: 'org.postgresql.Driver',
        JDBC_URL: `jdbc:postgresql://${this.database.clusterEndpoint.socketAddress}/bitbucket`,
        JDBC_USER: 'bitbucket',
      },
      secrets: {
        JDBC_PASSWORD: ecs.Secret.fromSecretsManager(this.databasePassowrd),
      }
    });

    container.addPortMappings({
      containerPort: 7990
    });

    // workaround for lack of CDK support for EFS
    const cfnTask = this.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;

    cfnTask.addPropertyOverride('Volumes', [{
      Name: 'bitbucket-shared',
      EFSVolumeConfiguration: {
        FilesystemId: this.fileSystem.fileSystemId,
        TransitEncryption: 'ENABLED'
      },
    }]);

    container.addMountPoints({
      sourceVolume: 'bitbucket-shared',
      containerPath: '/var/atlassian/application-data/bitbucket/shared',
      readOnly: false
    });

    // create the fargate service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      securityGroups: [
        taskSecurityGroup
      ]
    })

    this.service.connections.addSecurityGroup(taskSecurityGroup);

    // add the service the load balancer
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'BitBucketTG', {
      vpc: props.vpc,
      port: 7990,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetGroupName: 'bitbucket-server',
      targets: [
        this.service.loadBalancerTarget({
          containerName: 'server',
          containerPort: 7990
        })
      ]
    });

    targetGroup.configureHealthCheck({
      enabled: true,
      path: '/status',
      interval: cdk.Duration.seconds(15),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 3,
      unhealthyThresholdCount: 2
    });

    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.forward([targetGroup])
    });

    new cdk.CfnOutput(this, 'BitBucketURL', {
      value: this.loadBalancer.loadBalancerDnsName
    });

  }
}
