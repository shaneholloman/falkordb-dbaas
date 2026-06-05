import { Processor } from "bullmq";
import { setupContainer } from "../container";
import { ITasksDBRepository } from "../repositories/tasks";
import { K8sRepository } from "../repositories/k8s/K8sRepository";
import { IBlobStorageRepository } from "../repositories/blob/IBlobStorageRepository";
import { Logger } from 'pino';
import { RdbExportCopyRDBToBucketProcessorDataSchema, RdbExportCopyRDBToBucketProcessorData, RdbExportCopyRDBToBucketPodUploadProcessorData, RdbExportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1'
import { Value } from '@sinclair/typebox/value'
import { getExportTargetWriteUrl, makeExportOutputTarget } from '../repositories/blob/exportTargetUrls';
import { RDBExportTargetType } from '@falkordb/schemas/global';
import { MultiShardRDBExportPayloadType, SingleShardRDBExportPayloadType } from '../schemas/rdb-task';

const FETCH_TIMEOUT_MS = parseInt(process.env.RDB_EXPORT_FETCH_TIMEOUT_MS ?? '', 10) || 5 * 60 * 1000;

const fetchWithDeadline = async (url: string, init: RequestInit | undefined, description: string): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${description} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const resolveEffectiveTarget = async (
  tasksRepository: ITasksDBRepository,
  jobData: RdbExportCopyRDBToBucketProcessorData,
): Promise<RDBExportTargetType | undefined> => {
  const task = await tasksRepository.getTaskById(jobData.taskId);
  if (!task || (task.type !== 'SingleShardRDBExport' && task.type !== 'MultiShardRDBExport')) {
    return undefined;
  }

  const payload = task.payload as SingleShardRDBExportPayloadType | MultiShardRDBExportPayloadType;

  return payload.destination.fileName === jobData.fileName
    ? payload.destination.target as RDBExportTargetType | undefined
    : undefined;
};

const isPodUploadData = (jobData: RdbExportCopyRDBToBucketProcessorData): jobData is RdbExportCopyRDBToBucketPodUploadProcessorData => 'podId' in jobData;

const copyStagedRDBToTarget = async (
  blobRepository: IBlobStorageRepository,
  jobData: RdbExportCopyRDBToBucketProcessorData,
  target: RDBExportTargetType | undefined,
): Promise<void> => {
  const sourceReadUrl = await blobRepository.getReadUrl(
    jobData.bucketName,
    jobData.fileName,
    60 * 60 * 1000 // 1 hour
  )
  const targetWriteUrl = await getExportTargetWriteUrl(
    target,
    jobData.fileName,
    'application/octet-stream',
    60 * 60 * 1000 // 1 hour
  ) ?? await blobRepository.getWriteUrl(
    jobData.bucketName,
    jobData.fileName,
    'application/octet-stream',
    60 * 60 * 1000 // 1 hour
  )

  const sourceResponse = await fetchWithDeadline(sourceReadUrl, undefined, 'Reading exported RDB from staging bucket');
  if (!sourceResponse.ok || !sourceResponse.body) {
    throw new Error(`Failed to read exported RDB from staging bucket: ${sourceResponse.status} ${sourceResponse.statusText}`);
  }

  const targetResponse = await fetchWithDeadline(targetWriteUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
    },
    body: sourceResponse.body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }, 'Writing exported RDB to target');

  if (!targetResponse.ok) {
    throw new Error(`Failed to write exported RDB to target: ${targetResponse.status} ${targetResponse.statusText}`);
  }
}


const processor: Processor<RdbExportCopyRDBToBucketProcessorData> = async (job, token) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');

  logger.debug(`Processing 'rdb-export-copy-rdb-to-bucket' job ${job.id}`);


  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const k8sRepository = container.resolve<K8sRepository>(K8sRepository.name);
  const blobRepository = container.resolve<IBlobStorageRepository>(IBlobStorageRepository.name);

  try {
    Value.Assert(RdbExportCopyRDBToBucketProcessorDataSchema, job.data);

    const target = await resolveEffectiveTarget(tasksRepository, job.data);

    if (isPodUploadData(job.data)) {
      const writeUrl = await getExportTargetWriteUrl(
        target,
        job.data.fileName,
        'application/octet-stream',
        60 * 60 * 1000 // 1 hour
      ) ?? await blobRepository.getWriteUrl(
        job.data.bucketName,
        job.data.fileName,
        'application/octet-stream',
        60 * 60 * 1000 // 1 hour
      )

      await k8sRepository.sendUploadCommand(
        job.data.cloudProvider,
        job.data.clusterId,
        job.data.region,
        job.data.instanceId,
        job.data.podId,
        writeUrl,
      )
    } else {
      await copyStagedRDBToTarget(blobRepository, job.data, target);
    }

    const outputTarget = makeExportOutputTarget(target, job.data.fileName);

    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      status: 'completed',
      ...(outputTarget ? {
        output: {
          target: outputTarget,
        },
      } : {}),
    });

    return {
      success: true,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(error, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
}

export default {
  name: RdbExportTaskNames.RdbExportCopyRdbToBucket,
  processor,
  schema: RdbExportCopyRDBToBucketProcessorDataSchema,
}