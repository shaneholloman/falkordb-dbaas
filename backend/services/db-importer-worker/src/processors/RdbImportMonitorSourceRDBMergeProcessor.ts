import { RdbImportMonitorSourceRDBMergeProcessorData, RdbImportMonitorSourceRDBMergeProcessorDataSchema, RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { Value } from '@sinclair/typebox/value';
import { DelayedError, Processor } from 'bullmq';
import { Logger } from 'pino';
import { setupContainer } from '../container';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';

/**
 * Polls the Kubernetes merge job used by cluster source-instance imports.
 * The processor delays itself while the merge is pending and only allows the import flow to proceed
 * once the merged RDB exists in the managed import bucket.
 */
const processor: Processor<RdbImportMonitorSourceRDBMergeProcessorData> = async (job, token) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const k8sRepository = container.resolve<K8sRepository>(K8sRepository.name);

  logger.debug(`Processing 'rdb-import-monitor-source-rdb-merge' job ${job.id} with data: ${JSON.stringify(job.data, null, 2)}`);

  try {
    Value.Assert(RdbImportMonitorSourceRDBMergeProcessorDataSchema, job.data);

    const [jobStatus, logs] = await k8sRepository.getJobStatus(
      job.data.projectId,
      job.data.cloudProvider,
      job.data.clusterId,
      job.data.region,
      job.data.namespace,
      `merge-rdbs-job-${job.data.taskId}-source-import`,
    );

    if (jobStatus === 'failed') {
      throw new Error(`Source instance RDB merge job ${job.data.taskId} failed: ${logs ?? ''}`);
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
    logger.error(error, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
};

export default {
  name: RdbImportTaskNames.RdbImportMonitorSourceRDBMerge,
  processor,
  concurrency: undefined,
  schema: RdbImportMonitorSourceRDBMergeProcessorDataSchema,
};