import { DelayedError, Processor } from 'bullmq';
import { RdbImportMonitorCopySourceToBucketProcessorData, RdbImportMonitorCopySourceToBucketProcessorDataSchema, RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { Value } from '@sinclair/typebox/value';
import { Logger } from 'pino';
import { setupContainer } from '../container';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';

const processor: Processor<RdbImportMonitorCopySourceToBucketProcessorData> = async (job, token) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const k8sRepository = container.resolve<K8sRepository>(K8sRepository.name);

  logger.debug(`Processing 'rdb-import-monitor-copy-source-to-bucket' job ${job.id} with data: ${JSON.stringify(job.data, null, 2)}`);

  try {
    Value.Assert(RdbImportMonitorCopySourceToBucketProcessorDataSchema, job.data);

    const [jobStatus, logs] = await k8sRepository.getJobStatus(
      job.data.projectId,
      job.data.cloudProvider,
      job.data.clusterId,
      job.data.region,
      job.data.namespace,
      `${job.data.taskId}-copy-source-to-bucket`,
    );

    if (jobStatus === 'failed') {
      throw new Error(`K8s Job ${job.data.taskId}-copy-source-to-bucket failed${logs ? `: ${logs}` : ''}`);
    }

    if (jobStatus === 'pending') {
      await job.moveToDelayed(Date.now() + 5000, token);
      throw new DelayedError();
    }

    return { success: true };
  } catch (error) {
    if (error instanceof DelayedError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, data: job.data }, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
};

export default {
  name: RdbImportTaskNames.RdbImportMonitorCopySourceToBucket,
  processor,
  concurrency: undefined,
  schema: RdbImportMonitorCopySourceToBucketProcessorDataSchema,
};
