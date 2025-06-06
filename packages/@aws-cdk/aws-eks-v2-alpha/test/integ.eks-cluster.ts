/// !cdk-integ pragma:disable-update-workflow
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { App, CfnOutput, Duration, Token, Fn, Stack, StackProps } from 'aws-cdk-lib';
import * as integ from '@aws-cdk/integ-tests-alpha';
import * as cdk8s from 'cdk8s';
import * as kplus from 'cdk8s-plus-27';
import * as constructs from 'constructs';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import * as hello from './hello-k8s';
import * as eks from '../lib';
import { IAM_OIDC_REJECT_UNAUTHORIZED_CONNECTIONS } from 'aws-cdk-lib/cx-api';

class EksClusterStack extends Stack {
  private cluster: eks.Cluster;
  private vpc: ec2.IVpc;

  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);

    // allow all account users to assume this role in order to admin the cluster
    const mastersRole = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    const secretsEncryptionKey = new kms.Key(this, 'SecretsKey');

    // just need one nat gateway to simplify the test
    this.vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 3, natGateways: 1, restrictDefaultSecurityGroup: false });

    // Changing the subnets order should be supported
    const vpcSubnets: ec2.SubnetSelection[] = [
      { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      { subnetType: ec2.SubnetType.PUBLIC },
    ];

    // create the cluster with a default nodegroup capacity
    this.cluster = new eks.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      vpcSubnets,
      mastersRole,
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      defaultCapacity: 2,
      version: eks.KubernetesVersion.V1_32,
      secretsEncryptionKey,
      tags: {
        foo: 'bar',
      },
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.SCHEDULER,
      ],
      kubectlProviderOptions: {
        kubectlLayer: new KubectlV32Layer(this, 'kubectlLayer'),
      },
    });

    this.assertFargateProfile();

    this.assertCapacityX86();

    this.assertCapacityArm();

    this.assertBottlerocket();

    this.assertSpotCapacity();

    this.assertNodeGroupX86();

    this.assertNodeGroupSpot();

    this.assertNodeGroupArm();

    this.assertNodeGroupGraviton3();

    this.assertNodeGroupCustomAmi();

    this.assertNodeGroupGpu();

    this.assertSimpleManifest();

    this.assertManifestWithoutValidation();

    this.assertSimpleHelmChart();

    this.assertHelmChartAsset();

    this.assertSimpleCdk8sChart();

    this.assertCreateNamespace();

    this.assertServiceAccount();

    this.assertExtendedServiceAccount();

    new CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint });
    new CfnOutput(this, 'ClusterArn', { value: this.cluster.clusterArn });
    new CfnOutput(this, 'ClusterCertificateAuthorityData', { value: this.cluster.clusterCertificateAuthorityData });
    new CfnOutput(this, 'ClusterSecurityGroupId', { value: this.cluster.clusterSecurityGroupId });
    new CfnOutput(this, 'ClusterEncryptionConfigKeyArn', { value: this.cluster.clusterEncryptionConfigKeyArn });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'NodegroupName', { value: this.cluster.defaultNodegroup!.nodegroupName });
  }

  private assertServiceAccount() {
    // add a service account connected to a IAM role
    this.cluster.addServiceAccount('MyServiceAccount');
  }

  private assertExtendedServiceAccount() {
    // add a service account connected to a IAM role
    this.cluster.addServiceAccount('MyExtendedServiceAccount', {
      annotations: {
        'eks.amazonaws.com/sts-regional-endpoints': 'false',
      },
      labels: {
        'some-label': 'with-some-value',
      },
    });
  }

  private assertCreateNamespace() {
    // deploy an nginx ingress in a namespace
    const nginxNamespace = this.cluster.addManifest('nginx-namespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'nginx',
      },
    });

    const nginxIngress = this.cluster.addHelmChart('nginx-ingress', {
      chart: 'nginx-ingress',
      repository: 'https://helm.nginx.com/stable',
      namespace: 'nginx',
      wait: true,
      release: 'nginx-ingress',
      // https://github.com/nginxinc/helm-charts/tree/master/stable
      version: '0.17.1',
      values: {
        controller: {
          service: {
            create: false,
          },
        },
      },
      createNamespace: false,
      timeout: Duration.minutes(15),
    });

    // make sure namespace is deployed before the chart
    nginxIngress.node.addDependency(nginxNamespace);
  }

  private assertSimpleCdk8sChart() {
    class Chart extends cdk8s.Chart {
      constructor(scope: constructs.Construct, ns: string, cluster: eks.ICluster) {
        super(scope, ns);

        new kplus.ConfigMap(this, 'config-map', {
          data: {
            clusterName: cluster.clusterName,
          },
        });
      }
    }
    const app = new cdk8s.App();
    const chart = new Chart(app, 'Chart', this.cluster);

    this.cluster.addCdk8sChart('cdk8s-chart', chart);
  }
  private assertSimpleHelmChart() {
    // deploy the Kubernetes dashboard through a helm chart
    this.cluster.addHelmChart('dashboard', {
      chart: 'kubernetes-dashboard',
      // https://artifacthub.io/packages/helm/k8s-dashboard/kubernetes-dashboard
      version: '6.0.8',
      repository: 'https://kubernetes.github.io/dashboard/',
    });
  }

  private assertHelmChartAsset() {
    // get helm chart from Asset
    const chartAsset = new Asset(this, 'ChartAsset', {
      path: path.join(__dirname, 'test-chart'),
    });
    this.cluster.addHelmChart('test-chart', {
      chartAsset: chartAsset,
    });
  }

  private assertSimpleManifest() {
    // apply a kubernetes manifest
    this.cluster.addManifest('HelloApp', ...hello.resources);
  }
  private assertManifestWithoutValidation() {
    // apply a kubernetes manifest
    new eks.KubernetesManifest(this, 'HelloAppWithoutValidation', {
      cluster: this.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'ConfigMap',
        data: { hello: 'world' },
        metadata: { name: 'config-map' },
        unknown: { key: 'value' },
      }],
      skipValidation: true,
    });
  }
  private assertNodeGroupX86() {
    // add a extra nodegroup
    this.cluster.addNodegroupCapacity('extra-ng', {
      instanceTypes: [new ec2.InstanceType('t3.small')],
      minSize: 1,
      maxSize: 4,
      maxUnavailable: 3,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultCapacity ? this.cluster.defaultCapacity.role : undefined,
    });
  }
  private assertNodeGroupSpot() {
    // add a extra nodegroup
    this.cluster.addNodegroupCapacity('extra-ng-spot', {
      instanceTypes: [
        new ec2.InstanceType('c5.large'),
        new ec2.InstanceType('c5a.large'),
        new ec2.InstanceType('m7i-flex.large'),
      ],
      minSize: 3,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultCapacity ? this.cluster.defaultCapacity.role : undefined,
      capacityType: eks.CapacityType.SPOT,
    });
  }
  private assertNodeGroupCustomAmi() {
    // add a extra nodegroup
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -o xtrace',
      `/etc/eks/bootstrap.sh ${this.cluster.clusterName}`,
    );
    const lt = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData: {
        imageId: new eks.EksOptimizedImage({
          kubernetesVersion: eks.KubernetesVersion.V1_25.version,
        }).getImage(this).imageId,
        instanceType: new ec2.InstanceType('t3.small').toString(),
        userData: Fn.base64(userData.render()),
      },
    });
    this.cluster.addNodegroupCapacity('extra-ng2', {
      minSize: 1,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultNodegroup?.role || this.cluster.defaultCapacity?.role,
      launchTemplateSpec: {
        id: lt.ref,
        version: lt.attrDefaultVersionNumber,
      },
    });
  }
  private assertNodeGroupArm() {
    // add a extra nodegroup
    this.cluster.addNodegroupCapacity('extra-ng-arm', {
      instanceTypes: [new ec2.InstanceType('m6g.medium')],
      minSize: 1,
      maxUnavailablePercentage: 33,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultCapacity ? this.cluster.defaultCapacity.role : undefined,
    });
  }
  private assertNodeGroupGraviton3() {
    // add a Graviton3 nodegroup
    this.cluster.addNodegroupCapacity('extra-ng-arm3', {
      instanceTypes: [new ec2.InstanceType('c7g.large')],
      minSize: 1,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultCapacity ? this.cluster.defaultCapacity.role : undefined,
    });
  }
  private assertNodeGroupGpu() {
    // add a GPU nodegroup
    this.cluster.addNodegroupCapacity('extra-ng-gpu', {
      instanceTypes: [
        new ec2.InstanceType('p2.xlarge'),
        new ec2.InstanceType('g5.xlarge'),
        new ec2.InstanceType('g6e.xlarge'),
      ],
      minSize: 1,
      // reusing the default capacity nodegroup instance role when available
      nodeRole: this.cluster.defaultCapacity ? this.cluster.defaultCapacity.role : undefined,
    });
  }
  private assertSpotCapacity() {
    // spot instances (up to 10)
    this.cluster.addAutoScalingGroupCapacity('spot', {
      spotPrice: '0.1094',
      instanceType: new ec2.InstanceType('t3.large'),
      maxCapacity: 10,
      bootstrapOptions: {
        kubeletExtraArgs: '--node-labels foo=bar,goo=far',
        awsApiRetryAttempts: 5,
      },
    });
  }
  private assertBottlerocket() {
    // add bottlerocket nodes
    this.cluster.addAutoScalingGroupCapacity('BottlerocketNodes', {
      instanceType: new ec2.InstanceType('t3.small'),
      minCapacity: 2,
      machineImageType: eks.MachineImageType.BOTTLEROCKET,
    });
  }
  private assertCapacityX86() {
    // add some x86_64 capacity to the cluster. The IAM instance role will
    // automatically be mapped via aws-auth to allow nodes to join the cluster.
    this.cluster.addAutoScalingGroupCapacity('Nodes', {
      instanceType: new ec2.InstanceType('t2.medium'),
      minCapacity: 3,
    });
  }

  private assertCapacityArm() {
    // add some arm64 capacity to the cluster. The IAM instance role will
    // automatically be mapped via aws-auth to allow nodes to join the cluster.
    this.cluster.addAutoScalingGroupCapacity('NodesArm', {
      instanceType: new ec2.InstanceType('m6g.medium'),
      minCapacity: 1,
    });
  }

  private assertFargateProfile() {
    // fargate profile for resources in the "default" namespace
    this.cluster.addFargateProfile('default', {
      selectors: [{ namespace: 'default' }],
    });
  }
}

// this test uses both the bottlerocket image and the inf1 instance, which are only supported in these
// regions. see https://github.com/aws/aws-cdk/tree/main/packages/aws-cdk-lib/aws-eks#bottlerocket
// and https://aws.amazon.com/about-aws/whats-new/2019/12/introducing-amazon-ec2-inf1-instances-high-performance-and-the-lowest-cost-machine-learning-inference-in-the-cloud/
const supportedRegions = [
  'us-east-1',
  'us-west-2',
];

const app = new App({
  postCliContext: {
    [IAM_OIDC_REJECT_UNAUTHORIZED_CONNECTIONS]: false,
    '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': true,
    '@aws-cdk/aws-lambda:useCdkManagedLogGroup': false,
  },
});

// since the EKS optimized AMI is hard-coded here based on the region,
// we need to actually pass in a specific region.
const stack = new EksClusterStack(app, 'aws-cdk-eks-cluster', {
  env: { region: 'us-east-1' },
});

if (process.env.CDK_INTEG_ACCOUNT !== '12345678') {
  // only validate if we are about to actually deploy.
  // TODO: better way to determine this, right now the 'CDK_INTEG_ACCOUNT' seems like the only way.

  if (Token.isUnresolved(stack.region)) {
    throw new Error(`region (${stack.region}) cannot be a token and must be configured to one of: ${supportedRegions}`);
  }

  if (!supportedRegions.includes(stack.region)) {
    throw new Error(`region (${stack.region}) must be configured to one of: ${supportedRegions}`);
  }
}

new integ.IntegTest(app, 'aws-cdk-eks-cluster-integ', {
  testCases: [stack],
  // Test includes assets that are updated weekly. If not disabled, the upgrade PR will fail.
  diffAssets: false,
  cdkCommandOptions: {
    deploy: {
      args: {
        rollback: true,
      },
    },
  },
});
