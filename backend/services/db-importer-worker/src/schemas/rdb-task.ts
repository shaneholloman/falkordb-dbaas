import * as Yup from 'yup';

export enum TaskTypes {
  SingleShardRDBExport = 'SingleShardRDBExport',
  MultiShardRDBExport = 'MultiShardRDBExport',
  RDBImport = 'RDBImport',
}

const GCPServiceAccountKey = Yup.object({
  type: Yup.string().oneOf(['service_account']).required(),
  project_id: Yup.string().required(),
  private_key_id: Yup.string().required(),
  private_key: Yup.string().required(),
  client_email: Yup.string().email().required(),
  client_id: Yup.string().required(),
  auth_uri: Yup.string().required(),
  token_uri: Yup.string().required(),
  auth_provider_x509_cert_url: Yup.string().required(),
  client_x509_cert_url: Yup.string().required(),
  universe_domain: Yup.string().optional(),
}).strict().noUnknown().required();

const RDBExportTarget = Yup.lazy((value) => {
  switch (value?.type) {
    case 'gcs':
      return Yup.object({
        type: Yup.string().oneOf(['gcs']).required(),
        bucketName: Yup.string().required(),
        credentials: GCPServiceAccountKey,
      }).strict().noUnknown().required();
    case 's3':
      return Yup.object({
        type: Yup.string().oneOf(['s3']).required(),
        bucketName: Yup.string().required(),
        region: Yup.string().required(),
        accessKeyId: Yup.string().required(),
        secretAccessKey: Yup.string().required(),
        sessionToken: Yup.string().optional(),
      }).strict().noUnknown().required();
    default:
      return Yup.object({
        type: Yup.string().oneOf(['default']).optional(),
      }).strict().noUnknown().required();
  }
});

const RDBExportOutputTarget = Yup.lazy((value) => {
  switch (value?.type) {
    case 'gcs':
      return Yup.object({
        type: Yup.string().oneOf(['gcs']).required(),
        bucketName: Yup.string().required(),
        fileName: Yup.string().required(),
        path: Yup.string().required(),
      }).strict().noUnknown().required();
    case 's3':
      return Yup.object({
        type: Yup.string().oneOf(['s3']).required(),
        bucketName: Yup.string().required(),
        key: Yup.string().required(),
        region: Yup.string().required(),
        path: Yup.string().required(),
      }).strict().noUnknown().required();
    default:
      return Yup.mixed().oneOf([]).required();
  }
});

const RDBImportSource = Yup.lazy((value) => {
  switch (value?.type) {
    case 'gcs':
      return Yup.object({
        type: Yup.string().oneOf(['gcs']).required(),
        bucketName: Yup.string().required(),
        fileName: Yup.string().required(),
        credentials: GCPServiceAccountKey.required(),
      }).strict().noUnknown().required();
    case 's3':
      return Yup.object({
        type: Yup.string().oneOf(['s3']).required(),
        bucketName: Yup.string().required(),
        key: Yup.string().required(),
        region: Yup.string().required(),
        accessKeyId: Yup.string().required(),
        secretAccessKey: Yup.string().required(),
        sessionToken: Yup.string().optional(),
      }).strict().noUnknown().required();
    case 'url':
      return Yup.object({
        type: Yup.string().oneOf(['url']).required(),
        url: Yup.string().url().matches(/^https:\/\/[^\/@?#]+(?:[\/?#].*)?$/).required(),
      }).strict().noUnknown().required();
    case 'instance':
      return Yup.object({
        type: Yup.string().oneOf(['instance']).required(),
        instanceId: Yup.string().required(),
        cloudProvider: Yup.string().oneOf(['gcp', 'aws']).required(),
        clusterId: Yup.string().required(),
        region: Yup.string().required(),
        podId: Yup.string().required(),
        podIds: Yup.array(Yup.string().required()).required(),
        isCluster: Yup.boolean().required(),
        tls: Yup.boolean().required(),
      }).strict().noUnknown().required();
    default:
      return Yup.mixed().oneOf([]).required();
  }
});

export const SingleShardRDBExportPayload = Yup.object({
  cloudProvider: Yup.string().oneOf(['gcp', 'aws']).required(),
  region: Yup.string().required(),
  clusterId: Yup.string().required(),
  instanceId: Yup.string().required(),
  podId: Yup.string().required(),
  hasTLS: Yup.boolean().required(),
  destination: Yup.object({
    bucketName: Yup.string().required(),
    fileName: Yup.string().required(),
    expiresIn: Yup.number().required(),
    target: RDBExportTarget.optional(),
  }).required(),
}).strict().noUnknown().required();

export type SingleShardRDBExportPayloadType = Yup.InferType<typeof SingleShardRDBExportPayload>;

export const RDBExportOutput = Yup.object({
  readUrl: Yup.string().optional(),
  target: RDBExportOutputTarget.optional(),
}).strict().noUnknown().optional();
export type RDBExportOutputType = Yup.InferType<typeof RDBExportOutput>;


export const MultiShardRDBExportPayload = Yup.object({
  cloudProvider: Yup.string().oneOf(['gcp', 'aws']).required(),
  region: Yup.string().required(),
  clusterId: Yup.string().required(),
  instanceId: Yup.string().required(),
  podId: Yup.string().required(),
  hasTLS: Yup.boolean().required(),
  destination: Yup.object({
    bucketName: Yup.string().required(),
    expiresIn: Yup.number().required(),
    fileName: Yup.string().required(),
    target: RDBExportTarget.optional(),
    nodes: Yup.array().of(
      Yup.object({
        podId: Yup.string().required(),
        partFileName: Yup.string().required(),
      }).required()
    ).required(),
  }).required(),
}).strict().noUnknown().required();
export type MultiShardRDBExportPayloadType = Yup.InferType<typeof MultiShardRDBExportPayload>;

export const RDBImportPayload = Yup.object({
  cloudProvider: Yup.string().oneOf(['gcp', 'aws']).required(),
  region: Yup.string().required(),
  clusterId: Yup.string().required(),
  instanceId: Yup.string().required(),
  podIds: Yup.array(Yup.string()).required(),
  hasTLS: Yup.boolean().required(),
  bucketName: Yup.string().required(),
  fileName: Yup.string().required(),
  rdbSizeFileName: Yup.string().required(),
  rdbKeyNumberFileName: Yup.string().required(),
  deploymentSizeInMb: Yup.number().required(),
  backupPath: Yup.string().required(),
  aofEnabled: Yup.boolean().required(),
  isCluster: Yup.boolean().required(),
  source: RDBImportSource.optional(),
}).strict().noUnknown().required();

export type RDBImportPayloadType = Yup.InferType<typeof RDBImportPayload>;

export const RDBImportOutput = Yup.object({
  numberOfKeys: Yup.number().optional(),
}).strict().noUnknown().optional();

export type RDBImportOutputType = Yup.InferType<typeof RDBImportOutput>;

export interface IExportRDBTask {
  taskId: string;
  scheduleId?: string;
  type: TaskTypes;
  createdAt: string;
  updatedAt: string;
  status: 'created' | 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
  errors?: string[];
  payload: SingleShardRDBExportPayloadType | MultiShardRDBExportPayloadType | RDBImportPayloadType;
  output?: RDBExportOutputType | RDBImportOutputType;
}

export const RDBTask = Yup.object({
  taskId: Yup.string().required(),
  scheduleId: Yup.string().optional(),
  type: Yup.string().oneOf(Object.values(TaskTypes)).required(),
  createdAt: Yup.string().required(),
  updatedAt: Yup.string().required(),
  status: Yup.string().oneOf([
    'created',
    'pending',
    'in_progress',
    'completed',
    'failed',
  ]).default('pending').required(),
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Yup.string().optional(),
  errors: Yup.array().of(Yup.string().required()).optional(),
  payload: Yup.lazy((_, opt) => {
    switch (opt.parent.type) {
      case TaskTypes.SingleShardRDBExport:
        return SingleShardRDBExportPayload;
      case TaskTypes.MultiShardRDBExport:
        return MultiShardRDBExportPayload;
      case TaskTypes.RDBImport:
        return RDBImportPayload;
      default:
        return Yup.object();
    }
  }),
  output: Yup.lazy((_, opt) => {
    if (opt.parent.type === TaskTypes.SingleShardRDBExport || opt.parent.type === TaskTypes.MultiShardRDBExport) {
      return RDBExportOutput;
    }
    if (opt.parent.type === TaskTypes.RDBImport) {
      return RDBImportOutput;
    }
    return Yup.object();
  })
}).strict().noUnknown().required();

export type RDBTaskType = Yup.InferType<typeof RDBTask>;
