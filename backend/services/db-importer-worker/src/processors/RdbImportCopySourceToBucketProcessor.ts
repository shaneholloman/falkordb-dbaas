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

const CUSTOMER_SOURCE_COPY_TIMEOUT_MS = parseInt(process.env.RDB_IMPORT_SOURCE_COPY_TIMEOUT_MS ?? '', 10) || 5 * 60 * 1000;

const fetchWithDeadline = async (url: string, init: RequestInit | undefined, description: string): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOMER_SOURCE_COPY_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
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

    const [sourceReadUrl, destinationWriteUrl] = await Promise.all([
      getCustomerSourceReadUrl(task.payload.source),
      blobStorageRepository.getWriteUrl(
        job.data.bucketName,
        job.data.fileName,
        'application/octet-stream',
        60 * 60 * 1000,
      ),
    ]);

    const sourceResponse = await fetchWithDeadline(sourceReadUrl, undefined, 'Reading customer RDB source');
    if (!sourceResponse.ok || !sourceResponse.body) {
      throw new Error(`Failed to read customer RDB source: ${sourceResponse.status} ${sourceResponse.statusText}`);
    }

    const destinationResponse = await fetchWithDeadline(destinationWriteUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
      },
      body: sourceResponse.body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }, 'Writing customer RDB source to managed import bucket');

    if (!destinationResponse.ok) {
      throw new Error(`Failed to stage customer RDB source: ${destinationResponse.status} ${destinationResponse.statusText}`);
    }

    return { success: true };
  } catch (error) {
    logger.error({ error, data: sanitizeForLogging(job.data) }, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [error.message ?? error.toString()],
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
