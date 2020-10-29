import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as autoscaling from '@aws-cdk/aws-autoscaling';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as efs from '@aws-cdk/aws-efs';
import * as rds from '@aws-cdk/aws-rds';
import * as secretsManager from '@aws-cdk/aws-secretsmanager'
import * as iam from '@aws-cdk/aws-iam';
export interface BitBucketServerDatabaseProps {
  instanceType: ec2.InstanceType
}

export interface BitBucketServerProps {
  vpc: ec2.IVpc;
  database: BitBucketServerDatabaseProps;
  instanceType: ec2.InstanceType;
}

export class BitBucketServer extends cdk.Construct {

  loadBalancer: elbv2.ApplicationLoadBalancer;

  database: rds.DatabaseCluster;

  databasePassowrd: secretsManager.Secret;

  fileSystem: efs.FileSystem;


  constructor(scope: cdk.Construct, id: string, props: BitBucketServerProps) {
    super(scope, id);

    // create security groups
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket file system',
      allowAllOutbound: true
    });

    const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket server',
      allowAllOutbound: true
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'security group for the bitbucket load balancer',
      allowAllOutbound: true
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'allow access to the bitbucket database',
      allowAllOutbound: true
    });

    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'allow connections to the alb from the internet');
    appSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(7990), 'allow connections from the alb to the server');
    dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432), 'allow connections from the server to the database');
    efsSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(2049), 'allow connections from the vpc to the file system');

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

    // create the application server
    const appRole = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    this.databasePassowrd.grantRead(appRole);
    appRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforSSM'));

    const userData = ec2.UserData.forLinux();

    userData.addCommands(

      // base configuration
      'set -ex',
      'yum update -y',
      'yum install -y git curl jq ca-certificates java-11-amazon-corretto amazon-efs-utils',
      'echo "BITBUCKET_HOME=/var/atlassian/application-data/bitbucket" >> /etc/environment',
      'echo "BITBUCKET_INSTALL_DIR=/opt/atlassian/bitbucket" >> /etc/environment',
      'echo "BITBUCKET_VERSION=7.1.1" >> /etc/environment',
      'echo "AWS_REGION=$(curl -s 169.254.169.254/latest/dynamic/instance-identity/document | jq -r \'.region\')" >> /etc/environment',
      'echo "JAVA_HOME=/usr/lib/jvm/java-11-amazon-corretto.x86_64" >> /etc/environment',
      'echo "JRE_HOME=/etc/alternatives/jre" >> /etc/environment',
      'source /etc/environment',
      'aws configure set default.region ${AWS_REGION}',

      // mount the efs point
      'mkdir -p /var/atlassian',
      `mount -t efs -o tls ${this.fileSystem.fileSystemId}:/ /var/atlassian`,
      `echo "${this.fileSystem.fileSystemId}:/ /var/atlassian efs _netdev,tls,iam 0 0" >> /etc/fstab`,

      // install bitbucket
      'mkdir -p $BITBUCKET_HOME $BITBUCKET_INSTALL_DIR',
      'curl -L --silent https://product-downloads.atlassian.com/software/stash/downloads/atlassian-bitbucket-$BITBUCKET_VERSION.tar.gz | tar -xz --strip-components=1 -C "${BITBUCKET_INSTALL_DIR}"',

      // create the systemd unit file
      'echo "[Unit]" >> /etc/systemd/system/bitbucket.service',
      'echo "Description=Atlassian Bitbucket Server Service" >> /etc/systemd/system/bitbucket.service',
      'echo "After=syslog.target network.target" >> /etc/systemd/system/bitbucket.service',
      'echo "" >> /etc/systemd/system/bitbucket.service',
      'echo "[Service]" >> /etc/systemd/system/bitbucket.service',
      'echo "Environment=/etc/environment" >> /etc/systemd/system/bitbucket.service',
      'echo "Type=forking" >> /etc/systemd/system/bitbucket.service',
      'echo "ExecStart=$BITBUCKET_INSTALL_DIR/bin/start-bitbucket.sh" >> /etc/systemd/system/bitbucket.service',
      'echo "ExecStop=$BITBUCKET_INSTALL_DIR/bin/stop-bitbucket.sh" >> /etc/systemd/system/bitbucket.service',
      'echo "" >> /etc/systemd/system/bitbucket.service',
      'echo "[Install]" >> /etc/systemd/system/bitbucket.service',
      'echo "WantedBy=multi-user.target" >> /etc/systemd/system/bitbucket.service',

      // configure bitbucket, first we clear out the file
      'echo "" > $BITBUCKET_HOME/bitbucket.properties',
      'echo "jdbc.driver=org.postgresql.Driver" >> $BITBUCKET_HOME/bitbucket.properties',
      `echo "jdbc.url=jdbc:postgresql://${this.database.clusterEndpoint.socketAddress}/bitbucket" >> $BITBUCKET_HOME/bitbucket.properties`,
      'echo "jdbc.user=bitbucket" >> $BITBUCKET_HOME/bitbucket.properties',
      `echo "jdbc.password=$(aws secretsmanager get-secret-value --secret-id '${this.databasePassowrd.secretArn}' --query SecretString --output text)" >> $BITBUCKET_HOME/bitbucket.properties`,

      // restart the service
      'systemctl enable bitbucket.service && systemctl start bitbucket.service'
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc: props.vpc,
      instanceType: props.instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        edition: ec2.AmazonLinuxEdition.STANDARD,
        virtualization: ec2.AmazonLinuxVirt.HVM,
        storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      role: appRole,
      securityGroup: appSecurityGroup,
      minCapacity: 1,
      desiredCapacity: 1,
      maxCapacity: 1,
      userData
    });

    // add the appp the load balancer
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'BitBucketTG', {
      vpc: props.vpc,
      port: 7990,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg]
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
