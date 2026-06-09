import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Storage } from '@google-cloud/storage';
import { RdbImportCopySourceToBucketProcessorData, RdbImportCopySourceToBucketProcessorDataSchema, RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { ImportRDBTaskType, RDBImportSourceType, sanitizeForLogging } from '@falkordb/schemas/global';
import { Value } from '@sinclair/typebox/value';
import { Processor } from 'bullmq';
import { Logger } from 'pino';
import { setupContainer } from '../container';
import { IBlobStorageRepository } from '../repositories/blob/IBlobStorageRepository';
import { ITasksDBRepository } from '../repositories/tasks';
import { validateImportSourceUrl } from '@falkordb/security';

const CUSTOMER_SOURCE_COPY_TIMEOUT_MS = parseInt(process.env.RDB_IMPORT_SOURCE_COPY_TIMEOUT_MS ?? '', 10) || 5 * 60 * 1000;

const runWithCopyDeadline = async <T>(description: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOMER_SOURCE_COPY_TIMEOUT_MS);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`${description} timed out after ${CUSTOMER_SOURCE_COPY_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const getCustomerSourceReadUrl = async (source: RDBImportSourceType): Promise<string> => {
  if (source.type === 'gcs') {
    const storage = new Storage({
      projectId: source.credentials.project_id,
      credentials: source.credentials,
    });

    const [readUrl] = await storage
      .bucket(source.bucketName)
      .file(source.fileName)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
      });

    return readUrl;
  }

  if (source.type === 'url') {
    return (await validateImportSourceUrl(source.url)).toString();
  }

  if (source.type === 'instance') {
    throw new Error('Instance sources are exported directly to the managed import bucket');
  }

  const s3Client = new S3Client({
    region: source.region,
    credentials: {
      accessKeyId: source.accessKeyId,
      secretAccessKey: source.secretAccessKey,
      sessionToken: source.sessionToken,
    },
  });

  return getSignedUrl(
    s3Client as never,
    new GetObjectCommand({
      Bucket: source.bucketName,
      Key: source.key,
    }),
    { expiresIn: 60 * 60 },
  );
};

/**
 * Stages customer-supplied RDB sources from GCS, S3, or HTTPS URL into the managed import bucket.
 * Instance sources intentionally do not run here because they require source-pod export jobs and,
 * for clusters, an explicit merge flow before the regular import validation can start.
 */
const processor: Processor<RdbImportCopySourceToBucketProcessorData> = async (job) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const blobStorageRepository = container.resolve<IBlobStorageRepository>(IBlobStorageRepository.name);

  logger.debug(`Processing 'rdb-import-copy-source-to-bucket' job ${job.id} with data: ${JSON.stringify(job.data, null, 2)}`);

  try {
    Value.Assert(RdbImportCopySourceToBucketProcessorDataSchema, job.data);

    const task = await tasksRepository.getTaskById(job.data.taskId) as ImportRDBTaskType;
    if (!task || task.type !== 'RDBImport') {
      throw new Error(`Task ${job.data.taskId} not found or is not an RDB import task`);
    }
    if (!task.payload.source) {
      return { success: true, skipped: true };
    }

    if (task.payload.source.type === 'instance') {
      throw new Error('Instance sources must use the instance-source import flow');
    }

    const [sourceReadUrl, destinationWriteUrl] = await Promise.all([
      getCustomerSourceReadUrl(task.payload.source),
      blobStorageRepository.getWriteUrl(
        job.data.bucketName,
        job.data.fileName,
        'application/octet-stream',
        60 * 60 * 1000,
      ),
    ]);

    const destinationResponse = await runWithCopyDeadline('Copying customer RDB source to managed import bucket', async (signal) => {
      const sourceResponse = await fetch(sourceReadUrl, {
        redirect: 'manual',
        signal,
      });
      if (!sourceResponse.ok || !sourceResponse.body) {
        throw new Error(`Failed to read customer RDB source: ${sourceResponse.status} ${sourceResponse.statusText}`);
      }

      return fetch(destinationWriteUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
        },
        body: sourceResponse.body,
        duplex: 'half',
        redirect: 'manual',
        signal,
      } as RequestInit & { duplex: 'half' });
    });

    if (!destinationResponse.ok) {
      throw new Error(`Failed to stage customer RDB source: ${destinationResponse.status} ${destinationResponse.statusText}`);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, data: sanitizeForLogging(job.data) }, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
};

export default {
  name: RdbImportTaskNames.RdbImportCopySourceToBucket,
  processor,
  concurrency: undefined,
  schema: RdbImportCopySourceToBucketProcessorDataSchema,
};
