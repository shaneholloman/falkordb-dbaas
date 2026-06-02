import { type Static, Type } from '@sinclair/typebox';
import { SupportedCloudProviderSchema } from '.';


export const TaskTypesSchema = Type.Union([
  Type.Literal('SingleShardRDBExport'),
  Type.Literal('MultiShardRDBExport'),
  Type.Literal('RDBImport')
]);
export type TaskTypesType = Static<typeof TaskTypesSchema>;

export const RDBExportTaskTypesSchema = Type.Union([
  Type.Literal('SingleShardRDBExport'),
  Type.Literal('MultiShardRDBExport'),
]);
export type RDBExportTaskTypesType = Static<typeof RDBExportTaskTypesSchema>;

export const RDBExportDefaultTargetSchema = Type.Object({
  type: Type.Optional(Type.Literal('default')),
}, { additionalProperties: false });

export const GCPServiceAccountKeySchema = Type.Object({
  type: Type.Literal('service_account'),
  project_id: Type.String(),
  private_key_id: Type.String(),
  private_key: Type.String(),
  client_email: Type.String(),
  client_id: Type.String(),
  auth_uri: Type.String(),
  token_uri: Type.String(),
  auth_provider_x509_cert_url: Type.String(),
  client_x509_cert_url: Type.String(),
  universe_domain: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type GCPServiceAccountKeyType = Static<typeof GCPServiceAccountKeySchema>;

export const RDBExportGCSTargetSchema = Type.Object({
  type: Type.Literal('gcs'),
  bucketName: Type.String(),
  fileName: Type.Optional(Type.String()),
  credentials: GCPServiceAccountKeySchema,
}, { additionalProperties: false });

export const RDBExportS3TargetSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String(),
  key: Type.Optional(Type.String()),
  region: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
  sessionToken: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const RDBExportTargetSchema = Type.Union([
  RDBExportDefaultTargetSchema,
  RDBExportGCSTargetSchema,
  RDBExportS3TargetSchema,
]);
export type RDBExportTargetType = Static<typeof RDBExportTargetSchema>;

export const RDBExportPublicGCSTargetSchema = Type.Object({
  type: Type.Literal('gcs'),
  bucketName: Type.String(),
  fileName: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const RDBExportPublicS3TargetSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String(),
  key: Type.Optional(Type.String()),
  region: Type.String(),
}, { additionalProperties: false });

export const RDBExportPublicTargetSchema = Type.Union([
  RDBExportDefaultTargetSchema,
  RDBExportPublicGCSTargetSchema,
  RDBExportPublicS3TargetSchema,
]);
export type RDBExportPublicTargetType = Static<typeof RDBExportPublicTargetSchema>;

export const RDBExportOutputTargetSchema = Type.Union([
  Type.Object({
    type: Type.Literal('gcs'),
    bucketName: Type.String(),
    fileName: Type.String(),
    path: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('s3'),
    bucketName: Type.String(),
    key: Type.String(),
    region: Type.String(),
    path: Type.String(),
  }),
]);
export type RDBExportOutputTargetType = Static<typeof RDBExportOutputTargetSchema>;

export const SingleShardRDBExportPayloadSchema = Type.Object({
  cloudProvider: SupportedCloudProviderSchema,
  region: Type.String(),
  clusterId: Type.String(),
  instanceId: Type.String(),
  podId: Type.String(),
  hasTLS: Type.Boolean(),
  destination: Type.Object({
    bucketName: Type.String(),
    fileName: Type.String(),
    expiresIn: Type.Number(),
    target: Type.Optional(RDBExportTargetSchema),
  }),
});
export type SingleShardRDBExportPayloadType = Static<typeof SingleShardRDBExportPayloadSchema>;

export const MultiShardRDBExportPayloadSchema = Type.Object({
  cloudProvider: SupportedCloudProviderSchema,
  region: Type.String(),
  clusterId: Type.String(),
  instanceId: Type.String(),
  podId: Type.String(),
  hasTLS: Type.Boolean(),
  destination: Type.Object({
    nodes: Type.Array(
      Type.Object({
        podId: Type.String(),
        partFileName: Type.String(),
      }),
    ),
    fileName: Type.String(),
    bucketName: Type.String(),
    expiresIn: Type.Number(),
    target: Type.Optional(RDBExportTargetSchema),
  }),
});
export type MultiShardRDBExportPayloadType = Static<typeof MultiShardRDBExportPayloadSchema>;

export const RDBExportTaskPayloadSchema = Type.Union([
  SingleShardRDBExportPayloadSchema,
  MultiShardRDBExportPayloadSchema,
]);
export type RDBExportTaskPayloadType = Static<typeof RDBExportTaskPayloadSchema>;

export const SingleShardRDBExportPublicPayloadSchema = Type.Object({
  cloudProvider: SupportedCloudProviderSchema,
  region: Type.String(),
  clusterId: Type.String(),
  instanceId: Type.String(),
  podId: Type.String(),
  hasTLS: Type.Boolean(),
  destination: Type.Object({
    bucketName: Type.String(),
    fileName: Type.String(),
    expiresIn: Type.Number(),
    target: Type.Optional(RDBExportPublicTargetSchema),
  }),
});

export const MultiShardRDBExportPublicPayloadSchema = Type.Object({
  cloudProvider: SupportedCloudProviderSchema,
  region: Type.String(),
  clusterId: Type.String(),
  instanceId: Type.String(),
  podId: Type.String(),
  hasTLS: Type.Boolean(),
  destination: Type.Object({
    nodes: Type.Array(
      Type.Object({
        podId: Type.String(),
        partFileName: Type.String(),
      }),
    ),
    fileName: Type.String(),
    bucketName: Type.String(),
    expiresIn: Type.Number(),
    target: Type.Optional(RDBExportPublicTargetSchema),
  }),
});

export const RDBExportPublicTaskPayloadSchema = Type.Union([
  SingleShardRDBExportPublicPayloadSchema,
  MultiShardRDBExportPublicPayloadSchema,
]);
export type RDBExportPublicTaskPayloadType = Static<typeof RDBExportPublicTaskPayloadSchema>;

export const RDBExportOutputSchema = Type.Object({
  readUrl: Type.Optional(Type.String()),
  target: Type.Optional(RDBExportOutputTargetSchema),
});
export type RDBExportOutputType = Static<typeof RDBExportOutputSchema>;

export const TaskStatusSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type TaskStatusType = Static<typeof TaskStatusSchema>;

export const ExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  type: RDBExportTaskTypesSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: RDBExportTaskPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});
export type ExportRDBTaskType = Static<typeof ExportRDBTaskSchema>;

export const PublicExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  type: RDBExportTaskTypesSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: RDBExportPublicTaskPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});
export type PublicExportRDBTaskType = Static<typeof PublicExportRDBTaskSchema>;

export const RDBImportOutputSchema = Type.Object({
  numberOfKeys: Type.Optional(Type.Number()),
});
export type RDBImportOutputType = Static<typeof RDBImportOutputSchema>;

export const RDBImportTaskPayloadSchema = Type.Object({
  cloudProvider: SupportedCloudProviderSchema,
  region: Type.String(),
  clusterId: Type.String(),
  instanceId: Type.String(),
  podIds: Type.Array(Type.String()),
  hasTLS: Type.Boolean(),
  bucketName: Type.String(),
  fileName: Type.String(),
  rdbSizeFileName: Type.String(),
  rdbKeyNumberFileName: Type.String(),
  deploymentSizeInMb: Type.Number(),
  backupPath: Type.String(),
  aofEnabled: Type.Boolean(),
  isCluster: Type.Boolean(),
});
export type RDBImportTaskPayloadType = Static<typeof RDBImportTaskPayloadSchema>;

export const ImportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  type: TaskTypesSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: RDBImportTaskPayloadSchema,
  output: Type.Optional(RDBImportOutputSchema),
});
export type ImportRDBTaskType = Static<typeof ImportRDBTaskSchema>;

export const TaskDocumentSchema = Type.Union([
  ExportRDBTaskSchema,
  ImportRDBTaskSchema,
]);

export type TaskDocumentType = ExportRDBTaskType | ImportRDBTaskType;

export const PublicTaskDocumentSchema = Type.Union([
  PublicExportRDBTaskSchema,
  ImportRDBTaskSchema,
]);

export type PublicTaskDocumentType = PublicExportRDBTaskType | ImportRDBTaskType;