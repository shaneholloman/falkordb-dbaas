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
  bucketName: Type.String({ minLength: 1 }),
  credentials: GCPServiceAccountKeySchema,
}, { additionalProperties: false });

export const RDBExportS3TargetSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String({ minLength: 1 }),
  region: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
  sessionToken: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const RDBExportTargetSchema = Type.Union([
  RDBExportGCSTargetSchema,
  RDBExportS3TargetSchema,
  RDBExportDefaultTargetSchema,
]);
export type RDBExportTargetType = Static<typeof RDBExportTargetSchema>;

export const RDBExportPublicGCSTargetSchema = Type.Object({
  type: Type.Literal('gcs'),
  bucketName: Type.String(),
}, { additionalProperties: false });

export const RDBExportPublicS3TargetSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String(),
  region: Type.String(),
}, { additionalProperties: false });

export const RDBExportPublicTargetSchema = Type.Union([
  RDBExportPublicGCSTargetSchema,
  RDBExportPublicS3TargetSchema,
  RDBExportDefaultTargetSchema,
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

export const RDBImportGCSSourceSchema = Type.Object({
  type: Type.Literal('gcs'),
  bucketName: Type.String(),
  fileName: Type.String(),
  credentials: GCPServiceAccountKeySchema,
}, { additionalProperties: false });

export const RDBImportS3SourceSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String(),
  key: Type.String(),
  region: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
  sessionToken: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const RDBImportURLSourceSchema = Type.Object({
  type: Type.Literal('url'),
  url: Type.String({
    pattern: '^https:\/\/[^\/@?#]+(?:[\/?#].*)?$',
  }),
}, { additionalProperties: false });

export const RDBImportFileSourceSchema = Type.Object({
  type: Type.Literal('file'),
}, { additionalProperties: false });

export const RDBImportInstanceSourceSchema = Type.Object({
  type: Type.Literal('instance'),
  instanceId: Type.String(),
  cloudProvider: SupportedCloudProviderSchema,
  clusterId: Type.String(),
  region: Type.String(),
  podId: Type.String(),
  podIds: Type.Array(Type.String()),
  isCluster: Type.Boolean(),
  tls: Type.Boolean(),
}, { additionalProperties: false });

export const RDBImportRequestInstanceSourceSchema = Type.Object({
  type: Type.Literal('instance'),
  instanceId: Type.String(),
  username: Type.Optional(Type.String({
    pattern: "^[a-zA-Z0-9._-]+$",
    deprecated: true,
    description: 'Deprecated. Source instance access is authorized by subscription role.',
  })),
  password: Type.Optional(Type.String({
    deprecated: true,
    description: 'Deprecated. Source instance access is authorized by subscription role.',
  })),
}, { additionalProperties: false });

export const RDBImportRequestSourceSchema = Type.Union([
  RDBImportGCSSourceSchema,
  RDBImportS3SourceSchema,
  RDBImportURLSourceSchema,
  RDBImportRequestInstanceSourceSchema,
]);
export type RDBImportRequestSourceType = Static<typeof RDBImportRequestSourceSchema>;

export const RDBImportSourceSchema = Type.Union([
  RDBImportFileSourceSchema,
  RDBImportGCSSourceSchema,
  RDBImportS3SourceSchema,
  RDBImportURLSourceSchema,
  RDBImportInstanceSourceSchema,
], { default: { type: 'file' } });
export type RDBImportSourceType = Static<typeof RDBImportSourceSchema>;

export const RDBImportPublicGCSSourceSchema = Type.Object({
  type: Type.Literal('gcs'),
  bucketName: Type.String(),
  fileName: Type.String(),
}, { additionalProperties: false });

export const RDBImportPublicS3SourceSchema = Type.Object({
  type: Type.Literal('s3'),
  bucketName: Type.String(),
  key: Type.String(),
  region: Type.String(),
}, { additionalProperties: false });

export const RDBImportPublicURLSourceSchema = Type.Object({
  type: Type.Literal('url'),
}, { additionalProperties: false });

export const RDBImportPublicFileSourceSchema = Type.Object({
  type: Type.Literal('file'),
}, { additionalProperties: false });

export const RDBImportPublicInstanceSourceSchema = Type.Object({
  type: Type.Literal('instance'),
  instanceId: Type.String(),
}, { additionalProperties: false });

export const RDBImportPublicSourceSchema = Type.Union([
  RDBImportPublicFileSourceSchema,
  RDBImportPublicGCSSourceSchema,
  RDBImportPublicS3SourceSchema,
  RDBImportPublicURLSourceSchema,
  RDBImportPublicInstanceSourceSchema,
], { default: { type: 'file' } });
export type RDBImportPublicSourceType = Static<typeof RDBImportPublicSourceSchema>;

export const TaskStatusSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type TaskStatusType = Static<typeof TaskStatusSchema>;

export const SingleShardExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('SingleShardRDBExport'),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: SingleShardRDBExportPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});

export const MultiShardExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('MultiShardRDBExport'),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: MultiShardRDBExportPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});

export const ExportRDBTaskSchema = Type.Union([
  SingleShardExportRDBTaskSchema,
  MultiShardExportRDBTaskSchema,
]);
export type ExportRDBTaskType = Static<typeof ExportRDBTaskSchema>;

export const PublicSingleShardExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('SingleShardRDBExport'),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: SingleShardRDBExportPublicPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});

export const PublicMultiShardExportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('MultiShardRDBExport'),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: MultiShardRDBExportPublicPayloadSchema,
  output: Type.Optional(RDBExportOutputSchema),
});

export const PublicExportRDBTaskSchema = Type.Union([
  PublicSingleShardExportRDBTaskSchema,
  PublicMultiShardExportRDBTaskSchema,
]);
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
  source: Type.Optional(RDBImportSourceSchema),
});
export type RDBImportTaskPayloadType = Static<typeof RDBImportTaskPayloadSchema>;

export const RDBImportPublicTaskPayloadSchema = Type.Object({
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
  source: Type.Optional(RDBImportPublicSourceSchema),
});
export type RDBImportPublicTaskPayloadType = Static<typeof RDBImportPublicTaskPayloadSchema>;

export const ImportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('RDBImport'),
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

export const PublicImportRDBTaskSchema = Type.Object({
  taskId: Type.String(),
  scheduleId: Type.Optional(Type.String()),
  type: Type.Literal('RDBImport'),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  status: TaskStatusSchema,
  /**
   * @deprecated Use 'errors' field instead
   */
  error: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.String())),
  payload: RDBImportPublicTaskPayloadSchema,
  output: Type.Optional(RDBImportOutputSchema),
});
export type PublicImportRDBTaskType = Static<typeof PublicImportRDBTaskSchema>;

export const TaskDocumentSchema = Type.Union([
  ExportRDBTaskSchema,
  ImportRDBTaskSchema,
]);

export type TaskDocumentType = ExportRDBTaskType | ImportRDBTaskType;

export const PublicTaskDocumentSchema = Type.Union([
  PublicExportRDBTaskSchema,
  PublicImportRDBTaskSchema,
]);

export type PublicTaskDocumentType = PublicExportRDBTaskType | PublicImportRDBTaskType;