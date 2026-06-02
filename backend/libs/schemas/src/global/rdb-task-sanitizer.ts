import {
  ExportRDBTaskType,
  PublicTaskDocumentType,
  RDBExportPublicTargetType,
  RDBExportTargetType,
  TaskDocumentType,
} from './rdb-task';

const SENSITIVE_KEYS = new Set([
  'accessKeyId',
  'credentials',
  'private_key',
  'secretAccessKey',
  'sessionToken',
]);

const MASKED = '[REDACTED]';

export const sanitizeRDBExportTarget = (target?: RDBExportTargetType): RDBExportPublicTargetType | undefined => {
  switch (target?.type) {
    case 'gcs':
      return {
        type: 'gcs',
        bucketName: target.bucketName,
        fileName: target.fileName,
      };
    case 's3':
      return {
        type: 's3',
        bucketName: target.bucketName,
        key: target.key,
        region: target.region,
      };
    case 'default':
      return { type: 'default' };
    default:
      return undefined;
  }
};

export const sanitizeTaskDocument = (task: TaskDocumentType): PublicTaskDocumentType => {
  if (task.type !== 'SingleShardRDBExport' && task.type !== 'MultiShardRDBExport') {
    return task;
  }

  const exportTask = task as ExportRDBTaskType;
  const target = sanitizeRDBExportTarget(exportTask.payload.destination.target);

  return {
    ...exportTask,
    payload: {
      ...exportTask.payload,
      destination: {
        ...exportTask.payload.destination,
        target,
      },
    },
  };
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