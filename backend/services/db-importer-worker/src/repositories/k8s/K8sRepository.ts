import { Logger } from 'pino';
import * as k8s from '@kubernetes/client-node';
import { v1 as googleContainerV1 } from '@google-cloud/container';
import assert = require('assert');
import { Writable } from 'stream';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks';
import axios from 'axios';

const DEFAULT_REDIS_RDB_CLI_IMAGE = 'dudizimber/redis-rdb-cli@sha256:d279e342203d5018b1c803ff2690709d72eafd8f32595942e3224791e94d042e';
const IMAGE_PULL_FAILURE_REASONS = new Set([
  'CreateContainerConfigError',
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
]);

export class K8sRepository {
  constructor(private _options: { logger: Logger }) { }

  private _redisRdbCliImage(): string {
    return process.env.REDIS_RDB_CLI_IMAGE ?? DEFAULT_REDIS_RDB_CLI_IMAGE;
  }

  private async _getGKECredentials(clusterId: string, region: string, opts?: {
    projectId?: string,
  }) {
    const client = new googleContainerV1.ClusterManagerClient();

    const projectId = opts?.projectId ?? process.env.APPLICATION_PLANE_PROJECT_ID;
    assert(projectId, 'Env var APPLICATION_PLANE_PROJECT_ID is required');
    const accessToken = await client.auth.getAccessToken();

    const [response] = await client.getCluster({
      name: `projects/${projectId}/locations/${region}/clusters/${clusterId}`,
    });
    // the following are the parameters added when a new k8s context is created
    return {
      endpoint: `https://${response.endpoint}`,
      certificateAuthority: response.masterAuth.clusterCaCertificate,
      accessToken: accessToken,
    };
  }

  private async _getEKSCredentials(clusterId: string, region: string) {
    // get ID token from default GCP SA
    const targetAudience = process.env.AWS_TARGET_AUDIENCE;

    const res = await axios.get(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' +
      targetAudience,
      {
        headers: {
          'Metadata-Flavor': 'Google',
        },
      },
    );

    const idToken = res.data;

    const sts = new STSClient({ region });

    const { Credentials } = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: process.env.AWS_ROLE_ARN,
        RoleSessionName: 'db-importer-worker',
        WebIdentityToken: idToken,
      }),
    );

    const eks = new EKSClient({
      credentials: {
        accessKeyId: Credentials?.AccessKeyId,
        secretAccessKey: Credentials?.SecretAccessKey,
        sessionToken: Credentials?.SessionToken,
      },
      region,
    });

    const { cluster } = await eks.send(new DescribeClusterCommand({ name: clusterId }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const EKSToken = require('aws-eks-token');
    EKSToken.config = {
      accessKeyId: Credentials?.AccessKeyId,
      secretAccessKey: Credentials?.SecretAccessKey,
      sessionToken: Credentials?.SessionToken,
      region,
    };

    const token = await EKSToken.renew(clusterId);

    return {
      endpoint: cluster.endpoint,
      certificateAuthority: cluster.certificateAuthority.data,
      accessToken: token,
    };
  }

  private async _getK8sConfig(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    opts?: {
      projectId?: string,
    }
  ): Promise<k8s.KubeConfig> {
    const k8sCredentials =
      cloudProvider === 'gcp'
        ? await this._getGKECredentials(clusterId, region, opts)
        : await this._getEKSCredentials(clusterId, region);

    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [
        {
          name: clusterId,
          caData: k8sCredentials.certificateAuthority,
          server: k8sCredentials.endpoint,
        },
      ],
      users: [
        {
          name: clusterId,
          authProvider: cloudProvider === 'gcp' ? cloudProvider : undefined,
          token: k8sCredentials.accessToken,
        },
      ],
      contexts: [
        {
          name: clusterId,
          user: clusterId,
          cluster: clusterId,
        },
      ],
      currentContext: clusterId,
    });

    kubeConfig.applyToRequest = async (opts) => {
      opts.ca = Buffer.from(k8sCredentials.certificateAuthority, 'base64');
      opts.headers.Authorization = 'Bearer ' + k8sCredentials.accessToken;
    };

    return kubeConfig;
  }

  private async _getDeploymentPassword(kubeConfig: k8s.KubeConfig, instanceId: string, podId: string): Promise<string> {

    const password = await this._executeCommand(kubeConfig, instanceId, podId, [
      'cat',
      '/run/secrets/adminpassword',
    ]).catch((e) => {
      this._options.logger.error(e, 'Error getting deployment password');
      throw e;
    });

    if (!password) {
      throw new Error('Could not get password');
    }

    return this._normalizeRedisPassword(password);
  }

  private _normalizeRedisPassword(password: string): string {
    return password.replace(/[\r\n]+$/, '');
  }

  private _sanitizeCommandForError(command: string[]): string {
    const shellCommandIndex = command.findIndex((part, index) => part === '-c' && command[index - 1] === 'sh');

    return command.map((part, index) => {
      if (shellCommandIndex !== -1 && index > shellCommandIndex) {
        return index === shellCommandIndex + 1 ? '[REDACTED_SCRIPT]' : '[REDACTED]';
      }
      if (command[index - 1] === '-a' || command[index - 1] === '--pass' || command[index - 1] === '--password') {
        return '[REDACTED]';
      }
      if (part.startsWith('http://') || part.startsWith('https://')) {
        return '[REDACTED_URL]';
      }
      if (part.includes('PASSWORD=') || part.includes('WRITE_URL=') || part.includes('redis-cli')) {
        return '[REDACTED_SCRIPT]';
      }
      return part;
    }).join(' ');
  }

  private _sanitizeCommandOutputForError(output: string): string {
    return output
      .replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_URL]')
      .replace(/((?:password|token|access[_-]?key|secret[_-]?key|signature)=)[^\s&"'<>]+/gi, '$1[REDACTED]');
  }

  private async _executeCommand(kubeConfig: k8s.KubeConfig, instanceId: string, podId: string, command: string[], timeoutMs = 60 * 1000): Promise<string> {
    const exec = new k8s.Exec(kubeConfig);

    const outputStream = new Writable({
      write: (chunk, encoding, callback) => {
        callback();
      },
    });

    return new Promise((resolve, reject) => {
      let fullResponse = '';
      let settled = false;
      let execStream: { close?: () => void; terminate?: () => void; removeAllListeners?: () => void } | undefined;

      const cleanup = () => {
        clearTimeout(timeoutId);
        execStream?.removeAllListeners?.();
        outputStream.destroy();
      };

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const timeoutId = setTimeout(() => {
        execStream?.close?.();
        execStream?.terminate?.();
        const error = new Error(`Command timed out after ${timeoutMs}ms: ${this._sanitizeCommandForError(command)}`);
        error.name = 'TimeoutError';
        settle(() => reject(error));
      }, timeoutMs);

      exec.exec(
        instanceId,
        podId,
        'service',
        command,
        outputStream,
        null,
        null, // Stdin
        false // TTY
      ).then(
        (stream) => {
          execStream = stream as typeof execStream;
          if (settled) {
            execStream?.close?.();
            execStream?.terminate?.();
            execStream?.removeAllListeners?.();
            return;
          }
          stream.on('message', (data: Buffer) => {
            fullResponse += data.toString('utf8');
          });

          stream.on('close', (code: number, signal: string) => {

            if (code === 0 || code === 1000) {
              const successMarker = '{"metadata":{},"status":"Success"}';
              // eslint-disable-next-line no-control-regex
              fullResponse = fullResponse.replace(/(\x01)|(\x03)/g, '')
              if (fullResponse.endsWith(successMarker)) {
                settle(() => resolve(fullResponse.slice(0, -successMarker.length)));
              } else {
                settle(() => resolve(fullResponse));
              }
            } else {
              settle(() => reject(`Command failed with code ${code}, signal ${signal}:\n${this._sanitizeCommandOutputForError(fullResponse)}`));
            }
          });

          stream.on('error', (err: Error) => {
            settle(() => reject(`Error executing command: ${this._sanitizeCommandOutputForError(String(err))}`));
          });
        }
      ).catch(
        (err) => {
          settle(() => reject(`Error creating exec stream: ${this._sanitizeCommandOutputForError(String(err))}`));
        });
    });
  }

  async getFalkorDBDeploymentMode(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
  ): Promise<string> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Getting FalkorDB deployment mode');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'info'].filter((c) => c),
    ).catch((e) => {
      this._options.logger.error(e, 'Error getting deployment mode');
      throw e;
    });

    if (response.includes("NOAUTH")) {
      throw new Error('Failed to authenticate to FalkorDB');
    }

    return response.match(/redis_mode:(.*)/)[1].trim();
  }

  async sendSaveCommand(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, instanceId, podId, cloudProvider }, 'Sending save command');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'bgsave'].filter((c) => c),
    ).catch((e) => {
      this._options.logger.error(e, 'Error sending save command');
      throw e;
    });

    if (response.includes("NOAUTH")) {
      throw new Error('Failed to authenticate to FalkorDB');
    }
  }

  async sendRewriteAofCommand(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, instanceId, podId, cloudProvider }, 'Sending rewrite aof command');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'bgrewriteaof'].filter((c) => c),
    ).catch((e) => {
      this._options.logger.error(e, 'Error sending bgrewriteaof command');
      throw e;
    });

    if (response.includes("NOAUTH")) {
      throw new Error('Failed to authenticate to FalkorDB');
    }
  }

  async isSaving(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
  ): Promise<boolean> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Getting save status');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'info', 'persistence'].filter((c) => c),
    ).catch((e) => {
      this._options.logger.error(e, 'Error getting save status');
      throw e;
    });

    if (response.includes("NOAUTH")) {
      throw new Error('Failed to authenticate to FalkorDB');
    }

    return response.includes('rdb_bgsave_in_progress:1');
  }

  async isRewritingAof(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
  ): Promise<boolean> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Getting aof rewrite status');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'info', 'persistence'].filter((c) => c),
    ).catch((e) => {
      this._options.logger.error(e, 'Error getting save status');
      throw e;
    });

    if (response.includes("NOAUTH")) {
      throw new Error('Failed to authenticate to FalkorDB');
    }

    return response.includes('aof_rewrite_in_progress:1');
  }

  async getKeyCountFromAllPods(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS = false,
    isCluster = false,
  ): Promise<number> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Getting key count');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);

    // Pass the password via a positional arg + REDISCLI_AUTH so it is never
    // interpolated into the shell string. Avoids quoting/escaping problems
    // and shell-injection if the password contains spaces, $, `, ;, etc.
    const tlsFlag = hasTLS ? '--tls' : '';
    const shellCommand: string = isCluster ? `set -e
            REDISCLI_AUTH="$1"; export REDISCLI_AUTH
            (
              INITIAL_HOST="${podId}"
              INITIAL_PORT="6379"

              # Get IP:Port of all healthy master nodes (exclude fail/noaddr).
              CLUSTER_NODES=$(redis-cli ${tlsFlag} --no-auth-warning -h "$INITIAL_HOST" -p "$INITIAL_PORT" CLUSTER NODES)
              MASTER_NODES=$(echo "$CLUSTER_NODES" | awk '$3 ~ /master/ && $3 !~ /fail/ && $3 !~ /noaddr/ {print $2}' | cut -d'@' -f1)

              if [ -z "$MASTER_NODES" ]; then
                echo "ERROR: no healthy master nodes found" >&2
                exit 1
              fi

              # Loop through each master node and run graph.list. Fail loudly if any shard is unreachable.
              for NODE in $MASTER_NODES; do
                  IP=$(echo "$NODE" | cut -d: -f1)
                  PORT=$(echo "$NODE" | cut -d: -f2)
                  if [ -z "$IP" ] || [ -z "$PORT" ] || [ "$PORT" = "0" ]; then
                    echo "ERROR: invalid master address '$NODE'" >&2
                    exit 1
                  fi
                  OUT=$(redis-cli ${tlsFlag} --no-auth-warning -h "$IP" -p "$PORT" graph.list) || {
                    echo "ERROR: graph.list failed on $IP:$PORT" >&2
                    exit 1
                  }
                  # Normalize each line to just the graph name:
                  #   - strip optional "  1) " index prefix (TTY-style output),
                  #   - strip surrounding double quotes,
                  #   - drop empty / whitespace-only lines,
                  #   - drop the literal "(empty array)" placeholder.
                  echo "$OUT" \\
                    | sed -E 's/^[[:space:]]*[0-9]+\\)[[:space:]]*//; s/^"(.*)"$/\\1/' \\
                    | grep -vE '^[[:space:]]*$' \\
                    | grep -vxF '(empty array)' \\
                    || true
              done
            ) | sort -u | wc -l | tr -d ' '
        ` :
      `
            REDISCLI_AUTH="$1"; export REDISCLI_AUTH
            (
              RESPONSE=$(redis-cli ${tlsFlag} --no-auth-warning graph.list | grep -v '^(empty array)')
              if echo "$RESPONSE" | grep -q "(empty array)"; then
                echo "0"
              elif [ -z "$RESPONSE" ] || [ "$RESPONSE" = "" ] || [ "$RESPONSE" = $'\n' ]; then
                echo "0"
              else
                echo "$RESPONSE" | grep -cve '^s*$'
              fi
            )
        `;

    const response = await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      [
        'sh',
        '-c',
        shellCommand,
        'sh',
        password,
      ],
    ).catch((e) => {
      this._options.logger.error(e, 'Error getting key count');
      throw e;
    });
    this._options.logger.info({ response }, 'Key count response');

    const keyCount = parseInt(response, 10);
    if (isNaN(keyCount) || keyCount < 0) {
      this._options.logger.error({ response }, 'Invalid key count response');
      throw new Error('Invalid key count response');
    }

    return keyCount;
  }

  async sendUploadCommand(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    signedWriteUrl: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Sending upload command');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['curl', '-X', 'PUT', '-H', 'Content-Type: application/octet-stream', '--upload-file', '/data/dump.rdb', signedWriteUrl],
    ).catch((e) => {
      this._options.logger.error(e, 'Error sending upload command');
      throw e;
    });
  }

  async sendSaveAndUploadCommand(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    instanceId: string,
    podId: string,
    hasTLS: boolean,
    signedWriteUrl: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, instanceId, podId }, 'Sending default-user save and upload command');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);
    const password = await this._getDeploymentPassword(kubeConfig, instanceId, podId);
    const tlsFlag = hasTLS ? '--tls' : '';
    const shellCommand = `set -eu
      PASSWORD="$1"
      WRITE_URL="$2"

      redis-cli -a "$PASSWORD" ${tlsFlag} --no-auth-warning bgsave >/tmp/bgsave.out 2>&1 || {
        cat /tmp/bgsave.out >&2
        exit 1
      }

      attempt=1
      while [ $attempt -le 300 ]; do
        INFO=$(redis-cli -a "$PASSWORD" ${tlsFlag} --no-auth-warning info persistence) || exit 1
        case "$INFO" in
          *rdb_bgsave_in_progress:0*) break ;;
        esac
        attempt=$((attempt + 1))
        sleep 1
      done

      if [ $attempt -gt 300 ]; then
        echo "ERROR: timed out waiting for source RDB save" >&2
        exit 1
      fi

      if [ ! -s /data/dump.rdb ]; then
        echo "ERROR: source RDB file is empty or missing" >&2
        exit 1
      fi

      curl -fsS -X PUT -H 'Content-Type: application/octet-stream' --upload-file /data/dump.rdb "$WRITE_URL"
    `;

    await this._executeCommand(
      kubeConfig,
      instanceId,
      podId,
      ['sh', '-c', shellCommand, 'sh', password, signedWriteUrl],
      10 * 60 * 1000,
    ).catch((e) => {
      this._options.logger.error(e, 'Error sending default-user save and upload command');
      throw e;
    });
  }

  async createMergeRDBsJob(
    projectId: string,
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    jobId: string,
    bucketName: string,
    rdbFileNames: string[],
    outputRdbFileName: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, rdbFileNames }, 'Creating merge RDBs job');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region, { projectId });

    const jobManifest: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `merge-rdbs-job-${jobId}`,
        namespace,
      },
      spec: {
        maxFailedIndexes: 1,
        backoffLimitPerIndex: 0,
        completionMode: 'Indexed',
        template: {
          metadata: {
            annotations: {
              "gke-gcsfuse/volumes": "true",
              // service account
            }
          },
          spec: {
            serviceAccountName: 'db-exporter-sa',
            containers: [
              {
                name: 'merge-rdbs',
                image: this._redisRdbCliImage(),
                command: ['rdt', '-m', ...rdbFileNames.map(n => `/data/${n}`), '-o', `/data/${outputRdbFileName}`],
                volumeMounts: [
                  {
                    name: 'gcsfuse',
                    mountPath: '/data',
                  }
                ]
              },
            ],
            restartPolicy: 'Never',
            volumes: [
              {
                name: 'gcsfuse',
                csi: {
                  driver: 'gcsfuse.csi.storage.gke.io',
                  volumeAttributes: {
                    bucketName,
                    mountOptions: 'implicit-dirs',
                  },
                }
              }
            ]
          },
        },
      },
    };

    const k8sApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
    await k8sApi.createNamespacedJob(namespace, jobManifest);
  }

  async createImportRDBJob(
    projectId: string,
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    jobId: string,
    podId: string,
    hasTLS: boolean,
    downloadUrl: string,
  ): Promise<void> {
    this._options.logger.info({
      clusterId, region, namespace, jobId, podId, hasTLS,
    }, 'Creating import RDB job');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region, { projectId });
    const deploymentPassword = await this._getDeploymentPassword(kubeConfig, namespace, podId);

    const k8sCoreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const secrets = await k8sCoreApi.listNamespacedSecret(namespace).then((res) => res.body.items);
    const fileSecrets = secrets.filter((s) => s.metadata?.name?.startsWith('file'));
    const fileSecretsWithAdminPassword = fileSecrets.filter((s) => s.data?.adminpassword);
    const mismatchedPasswordSecrets = fileSecretsWithAdminPassword.filter((secret) => {
      const encodedPassword = secret.data?.adminpassword;
      if (!encodedPassword) {
        return false;
      }
      const secretPassword = this._normalizeRedisPassword(
        Buffer.from(encodedPassword, 'base64').toString('utf8'),
      );
      return secretPassword !== deploymentPassword;
    });

    if (fileSecretsWithAdminPassword.length === 0) {
      throw new Error(`Could not find file secrets with adminpassword in namespace ${namespace}`);
    }
    if (mismatchedPasswordSecrets.length > 0) {
      throw new Error(
        `Found file secrets with adminpassword that does not match pod ${podId}: ${mismatchedPasswordSecrets.map((s) => s.metadata?.name).join(', ')}`,
      );
    }

    const tlsFlag = hasTLS ? '--tls' : '';
    const scheme = hasTLS ? 'rediss' : 'redis';
    const shellCommand = `set -eu

      # Validate required env before doing anything destructive.
      if [ -z "\${adminpassword:-}" ]; then
        echo "ERROR: adminpassword env var is not set" >&2
        exit 1
      fi
      PASS=$(printf '%s' "$adminpassword" | tr -d '\r\n')

      apk --update add curl redis >/dev/null \\
        || { echo "ERROR: failed to install curl/redis" >&2; exit 1; }

      curl -fsS -X GET -H "Accept: application/octet-stream" \\
        --output /data/dump.rdb "${downloadUrl}" \\
        || { echo "ERROR: failed to download RDB from signed URL" >&2; exit 1; }
      if [ ! -s /data/dump.rdb ]; then
        echo "ERROR: downloaded RDB is empty" >&2
        exit 1
      fi

      INFO=$(redis-cli ${tlsFlag} -h ${podId} -a "$PASS" --no-auth-warning info) \\
        || { echo "ERROR: failed to query INFO on ${podId}" >&2; exit 1; }
      if [ -z "$INFO" ]; then
        echo "ERROR: empty INFO response from ${podId}" >&2
        exit 1
      fi
      case "$INFO" in
        *NOAUTH*) echo "ERROR: authentication to ${podId} failed (NOAUTH)" >&2; exit 1 ;;
      esac

      TARGET_HOST="${podId}"
      if echo "$INFO" | grep -q "redis_mode:standalone" && echo "$INFO" | grep -q "role:slave"; then
        TARGET_HOST=$(echo "$INFO" | grep "master_host" | cut -d':' -f2 | tr -d ' \\r')
        if [ -z "$TARGET_HOST" ]; then
          echo "ERROR: could not resolve master_host from INFO" >&2
          exit 1
        fi
      fi

      # In cluster mode, disable replica auto-failover for the duration of the
      # import. A failover mid-import causes ack'd-but-not-yet-replicated
      # RESTORE writes to be lost when the replica is promoted.
      REPLICAS=""
      if echo "$INFO" | grep -q "redis_mode:cluster"; then
        REPLICAS=$(redis-cli ${tlsFlag} -h ${podId} -a "$PASS" --no-auth-warning CLUSTER NODES \\
          | awk '$3 ~ /slave/ && $3 !~ /fail/ && $3 !~ /noaddr/ {print $2}' \\
          | cut -d'@' -f1) \\
          || { echo "ERROR: failed to query CLUSTER NODES on ${podId}" >&2; exit 1; }
      fi

      # Track which replicas we successfully flipped to no-failover=yes so we
      # only attempt to restore the ones we actually changed, and so cleanup
      # can report on every individual node it touched.
      DISABLED_REPLICAS=""

      # Try CONFIG SET cluster-slave-no-failover on a single replica, with a
      # small retry loop. Returns 0 on success, non-zero on failure.
      try_set_no_failover() {
        ip="$1"; port="$2"; val="$3"
        attempt=1
        while [ $attempt -le 3 ]; do
          out=$(redis-cli ${tlsFlag} -h "$ip" -p "$port" -a "$PASS" --no-auth-warning \\
            CONFIG SET cluster-slave-no-failover "$val" 2>&1) && [ "$out" = "OK" ] && return 0
          echo "WARN: CONFIG SET cluster-slave-no-failover=$val on $ip:$port attempt $attempt failed: $out" >&2
          attempt=$((attempt + 1))
          sleep 1
        done
        return 1
      }

      disable_failover() {
        for R in $REPLICAS; do
          IP="\${R%:*}"
          PORT="\${R#*:}"
          [ -z "$IP" ] || [ -z "$PORT" ] || [ "$PORT" = "0" ] && continue
          if try_set_no_failover "$IP" "$PORT" yes; then
            DISABLED_REPLICAS="$DISABLED_REPLICAS $IP:$PORT"
          else
            # Don't fail the import outright on a single replica that we
            # couldn't lock down — but make it impossible to miss in logs.
            echo "ERROR: could not disable auto-failover on $IP:$PORT; import will continue but this shard is unprotected" >&2
          fi
        done
      }

      # Best-effort restore on every replica we previously disabled. Any
      # node we cannot restore is escalated as a high-visibility ERROR so
      # operators can manually re-enable failover and avoid leaving the
      # cluster in a degraded HA state.
      cleanup() {
        rc=$?
        FAILED_RESTORES=""
        for NODE in $DISABLED_REPLICAS; do
          IP="\${NODE%:*}"
          PORT="\${NODE#*:}"
          if ! try_set_no_failover "$IP" "$PORT" no; then
            FAILED_RESTORES="$FAILED_RESTORES $IP:$PORT"
          fi
        done
        if [ -n "$FAILED_RESTORES" ]; then
          echo "ERROR: FAILED to re-enable auto-failover on the following replicas:$FAILED_RESTORES" >&2
          echo "ERROR: cluster HA is degraded on those nodes. Run:" >&2
          echo "ERROR:   redis-cli -h <node> -p <port> -a <pass> CONFIG SET cluster-slave-no-failover no" >&2
          # If the import itself succeeded, surface the cleanup failure as
          # a non-zero exit so the Job is marked failed and gets attention.
          [ $rc -eq 0 ] && rc=2
        fi
        exit $rc
      }
      trap cleanup EXIT INT TERM

      disable_failover

      # Percent-encode every byte of the password so that characters like
      # @, :, /, %, or whitespace cannot break the redis URI parser in rmt.
      ENC_PASS=$(printf '%s' "$PASS" | od -An -tx1 -v | tr -d ' \\n' | sed 's/../%&/g')

      URL="${scheme}://$TARGET_HOST:6379?authPassword=$ENC_PASS"
      rmt -s /data/dump.rdb -m "$URL" -r \\
        || { rc=$?; echo "ERROR: rmt import failed with exit code $rc" >&2; exit $rc; }`;

    const jobManifest: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobId,
        namespace,
      },
      spec: {
        maxFailedIndexes: 1,
        backoffLimitPerIndex: 0,
        completionMode: 'Indexed',
        template: {
          spec: {
            containers: [
              {
                name: 'import-rdb',
                image: this._redisRdbCliImage(),
                command: ['sh', '-c', shellCommand],
                volumeMounts: [
                  {
                    name: 'emptydir',
                    mountPath: '/data',
                  },
                ],
                envFrom: fileSecrets.map((s) => ({
                  secretRef: {
                    name: s.metadata?.name,
                  }
                }))
              },
            ],
            restartPolicy: 'Never',
            volumes: [
              {
                name: 'emptydir',
                emptyDir: {},
              },
            ]
          },
        },
      },
    };

    const k8sApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
    await k8sApi.createNamespacedJob(namespace, jobManifest);

  }

  async createValidateRdbFormatJob(
    projectId: string,
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    jobId: string,
    bucketName: string,
    fileName: string,
    outputFileName: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, bucketName, fileName, outputFileName }, 'Creating validate RDB format job');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region, { projectId });

    const shellCommand: string = `(
      rct -f count -t module -s /data/${fileName} -o count.csv && \
      echo "$(cat count.csv | awk -F',' 'NR==2 {print $1}')" > /data/${outputFileName}
    )`;

    const jobManifest: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobId,
        namespace,
      },
      spec: {
        maxFailedIndexes: 1,
        backoffLimitPerIndex: 0,
        completionMode: 'Indexed',
        template: {
          metadata: {
            annotations: {
              "gke-gcsfuse/volumes": "true",
            }
          },
          spec: {
            serviceAccountName: 'db-exporter-sa',
            containers: [
              {
                name: 'redis-rdb-cli',
                image: this._redisRdbCliImage(),
                command: ['sh', '-c', shellCommand],
                volumeMounts: [
                  {
                    name: 'gcsfuse',
                    mountPath: '/data',
                  }
                ]
              },
            ],
            restartPolicy: 'Never',
            volumes: [
              {
                name: 'gcsfuse',
                csi: {
                  driver: 'gcsfuse.csi.storage.gke.io',
                  volumeAttributes: {
                    bucketName,
                    mountOptions: 'implicit-dirs',
                  },
                }
              }
            ]
          },
        },
      },
    };

    const k8sApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
    await k8sApi.createNamespacedJob(namespace, jobManifest);
  }

  async createValidateRdbSizeJob(
    projectId: string,
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    jobId: string,
    bucketName: string,
    fileName: string,
    outputFileName: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, bucketName, fileName, outputFileName }, 'Creating validate RDB size job');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region, { projectId });

    const shellCommand: string = `(
      rdb-used-memory /data/${fileName} > /data/${outputFileName}
    )`;

    const jobManifest: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobId,
        namespace,
      },
      spec: {
        maxFailedIndexes: 1,
        backoffLimitPerIndex: 0,
        completionMode: 'Indexed',
        template: {
          metadata: {
            annotations: {
              "gke-gcsfuse/volumes": "true",
            }
          },
          spec: {
            serviceAccountName: 'db-exporter-sa',
            containers: [
              {
                name: 'rdb-used-memory',
                image: 'falkordb/rdb-used-memory:v1.3.0',
                command: ['sh', '-c', shellCommand],
                volumeMounts: [
                  {
                    name: 'gcsfuse',
                    mountPath: '/data',
                  }
                ]
              },
            ],
            restartPolicy: 'Never',
            volumes: [
              {
                name: 'gcsfuse',
                csi: {
                  driver: 'gcsfuse.csi.storage.gke.io',
                  volumeAttributes: {
                    bucketName,
                    mountOptions: 'implicit-dirs',
                  },
                }
              }
            ]
          },
        },
      },
    };

    const k8sApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
    await k8sApi.createNamespacedJob(namespace, jobManifest);
  }

  async getJobStatus(
    projectId: string,
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    jobId: string,
  ): Promise<['pending' | 'completed' | 'failed', string?]> {
    this._options.logger.info({ clusterId, region, namespace, jobId }, 'Getting job status');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region, { projectId });

    const k8sApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
    const k8sCoreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const { body } = await k8sApi.readNamespacedJob(`${jobId}`, namespace);
    const { status } = body;

    if (status?.failed > 0) {
      // get logs
      const pods = await k8sCoreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${body.metadata?.name}`);
      const logs = await k8sCoreApi.readNamespacedPodLog(
        pods.body.items?.[0]?.metadata?.name || '',
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1000,
      ).catch((e) => {
        this._options.logger.error(e, 'Error getting job logs');
        return { body: '' };
      });
      return ['failed', logs.body];
    }

    if (status?.succeeded > 0) {
      return ['completed'];
    }

    const pods = await k8sCoreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${body.metadata?.name}`);
    const waitingState = pods.body.items
      .flatMap((pod) => pod.status?.containerStatuses ?? [])
      .map((containerStatus) => containerStatus.state?.waiting)
      .find((waiting) => waiting?.reason && IMAGE_PULL_FAILURE_REASONS.has(waiting.reason));

    if (waitingState) {
      return ['failed', waitingState.message ?? waitingState.reason];
    }

    return ['pending'];
  }

  async makeLocalBackup(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    podId: string,
    aofEnabled: boolean,
    backupPath: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, podId, aofEnabled, backupPath }, 'Making local backup');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const shellCommand = aofEnabled ?
      `mkdir -p /data/backup && cp -rf /data/appendonlydir ${backupPath}` :
      `mkdir -p /data/backup && cp /data/dump.rdb ${backupPath}`;


    await this._executeCommand(
      kubeConfig,
      namespace,
      podId,
      ['sh', '-c', shellCommand]
    ).catch((e) => {
      this._options.logger.error(e, 'Error making local backup');
      throw e;
    });
  }

  async restoreLocalBackup(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    podIds: string[],
    aofEnabled: boolean,
    backupPath: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, podIds, aofEnabled, backupPath }, 'Restoring local backup folder');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    for (const podId of podIds) {
      try {
        await this._executeCommand(
          kubeConfig,
          namespace,
          podId,
          aofEnabled ?
            ['mv', '-f', backupPath, '/data'] :
            ['mv', backupPath, '/data/dump.rdb'],
        ).then(() => this.deleteLocalBackup(
          cloudProvider,
          clusterId,
          region,
          namespace,
          podId,
          backupPath,
        ))
      } catch (e) {
        this._options.logger.error(e, `Error restoring local backup folder from pod ${podId}`);
        throw e;
      }
    }
  }

  async deleteLocalBackup(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    podId: string,
    backupPath: string,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, podId }, 'Deleting local backup');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    await this._executeCommand(
      kubeConfig,
      namespace,
      podId,
      ['rm', '-rf', backupPath],
    )
  }

  async flushInstance(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    podId: string,
    hasTLS = false,
    aofEnabled: boolean = false,
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, podId }, 'Flushing instance');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const password = await this._getDeploymentPassword(kubeConfig, namespace, podId);

    await this._executeCommand(
      kubeConfig,
      namespace,
      podId,
      ['redis-cli', hasTLS ? '--tls' : '', '-a', password, '--no-auth-warning', 'flushall'].filter((c) => c),
    )
      .then(() => {
        if (aofEnabled) {
          return this.sendRewriteAofCommand(cloudProvider, clusterId, region, namespace, podId, hasTLS);
        } else {
          return this.sendSaveCommand(cloudProvider, clusterId, region, namespace, podId, hasTLS);
        }
      })
      .catch((e) => {
        this._options.logger.error(e, 'Error flushing instance');
        throw e;
      });
  }

  async deletePods(
    cloudProvider: 'gcp' | 'aws',
    clusterId: string,
    region: string,
    namespace: string,
    podIds: string[],
  ): Promise<void> {
    this._options.logger.info({ clusterId, region, namespace, podIds }, 'Deleting pods');

    const kubeConfig = await this._getK8sConfig(cloudProvider, clusterId, region);

    const k8sApi = kubeConfig.makeApiClient(k8s.CoreV1Api);

    for (const podId of podIds) {
      try {
        await k8sApi.deleteNamespacedPod(podId, namespace, undefined, undefined, 0);
      } catch (e) {
        this._options.logger.error(e, `Error deleting pod ${podId}`);
        throw e;
      }
    }
  }
}
