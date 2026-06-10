import {
  ExportRDBTaskType,
  ImportRDBTaskType,
  PublicTaskDocumentType,
  RDBExportPublicTargetType,
  RDBExportTargetType,
  RDBImportPublicSourceType,
  RDBImportSourceType,
  TaskDocumentType,
} from './rdb-task';

const SENSITIVE_KEYS = new Set([
  'accessKeyId',
  'credentials',
  'private_key',
  'password',
  'secretAccessKey',
  'sessionToken',
  'url',
]);

const MASKED = '[REDACTED]';

export const sanitizeRDBExportTarget = (target?: RDBExportTargetType): RDBExportPublicTargetType | undefined => {
  switch (target?.type) {
    case 'gcs':
      return {
        type: 'gcs',
        bucketName: target.bucketName,
      };
    case 's3':
      return {
        type: 's3',
        bucketName: target.bucketName,
        region: target.region,
      };
    case 'default':
      return { type: 'default' };
    default:
      return undefined;
  }
};

export const sanitizeRDBImportSource = (source?: RDBImportSourceType | RDBImportPublicSourceType): RDBImportPublicSourceType | undefined => {
  switch (source?.type) {
    case 'gcs':
      return {
        type: 'gcs',
        bucketName: source.bucketName,
        fileName: source.fileName,
      };
    case 's3':
      return {
        type: 's3',
        bucketName: source.bucketName,
        key: source.key,
        region: source.region,
      };
    case 'url':
      return {
        type: 'url',
      };
    case 'instance':
      return {
        type: 'instance',
        instanceId: source.instanceId,
      };
    default:
      return undefined;
  }
};

export const sanitizeTaskDocument = (task: TaskDocumentType): PublicTaskDocumentType => {
  if (task.type === 'RDBImport') {
    const importTask = task as ImportRDBTaskType;

    return {
      ...importTask,
      payload: {
        ...importTask.payload,
        source: sanitizeRDBImportSource(importTask.payload.source),
      },
    } as PublicTaskDocumentType;
  }

  if (task.type !== 'SingleShardRDBExport' && task.type !== 'MultiShardRDBExport') {
    return task as PublicTaskDocumentType;
  }

  const exportTask = task as ExportRDBTaskType;
  const target = sanitizeRDBExportTarget(exportTask.payload.destination.target);

  if (exportTask.type === 'SingleShardRDBExport') {
    return {
      ...exportTask,
      payload: {
        ...exportTask.payload,
        destination: {
          ...exportTask.payload.destination,
          target,
        },
      },
    } as PublicTaskDocumentType;
  }

  return {
    ...exportTask,
    payload: {
      ...exportTask.payload,
      destination: {
        ...exportTask.payload.destination,
        target,
      },
    },
  } as PublicTaskDocumentType;
};

export const sanitizeForLogging = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLogging(item)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.has(key) ? MASKED : sanitizeForLogging(entry),
    ]),
  ) as T;
};