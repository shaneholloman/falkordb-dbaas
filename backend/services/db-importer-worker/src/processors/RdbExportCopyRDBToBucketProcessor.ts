import { Processor } from "bullmq";
import { setupContainer } from "../container";
import { ITasksDBRepository } from "../repositories/tasks";
import { K8sRepository } from "../repositories/k8s/K8sRepository";
import { IBlobStorageRepository } from "../repositories/blob/IBlobStorageRepository";
import { Logger } from 'pino';
import { RdbExportCopyRDBToBucketProcessorDataSchema, RdbExportCopyRDBToBucketProcessorData, RdbExportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1'
import { Value } from '@sinclair/typebox/value'
import { getExportTargetWriteUrl, makeExportOutputTarget } from '../repositories/blob/exportTargetUrls';

const copyStagedRDBToTarget = async (
  blobRepository: IBlobStorageRepository,
  jobData: RdbExportCopyRDBToBucketProcessorData,
): Promise<void> => {
  const sourceReadUrl = await blobRepository.getReadUrl(
    jobData.bucketName,
    jobData.fileName,
    60 * 60 * 1000 // 1 hour
  )
  const targetWriteUrl = await getExportTargetWriteUrl(
    jobData.target,
    jobData.fileName,
    'application/octet-stream',
    60 * 60 * 1000 // 1 hour
  )

  const sourceResponse = await fetch(sourceReadUrl);
  if (!sourceResponse.ok || !sourceResponse.body || !targetWriteUrl) {
    throw new Error(`Failed to read exported RDB from staging bucket: ${sourceResponse.status} ${sourceResponse.statusText}`);
  }

  const targetResponse = await fetch(targetWriteUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
    },
    body: sourceResponse.body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

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


    if (job.data.podId) {
      const writeUrl = await getExportTargetWriteUrl(
        job.data.target,
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
      await copyStagedRDBToTarget(blobRepository, job.data);
    }

    const outputTarget = makeExportOutputTarget(job.data.target, job.data.fileName);

    if (outputTarget) {
      await tasksRepository.updateTask({
        taskId: job.data.taskId,
        status: 'completed',
        output: {
          target: outputTarget,
        },
      });
    }

    return {
      success: true,
    }
  } catch (error) {
    logger.error(error, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [error.message ?? error.toString()],
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