import { Queue, Worker } from 'bullmq';
import processors from '../processors';
import logger from '../logger';
import { setupContainer } from '../container';
import { ITasksDBRepository } from '../repositories/tasks';

export let workerError = false;

export const getQueues = () => {
  const queues = processors.map(({ name }) => new Queue(name, {
    connection: {
      url: process.env.REDIS_URL,
    },
  }));

  for (const q of queues) {
    q.on('error', (error) => {
      logger.error(`Queue ${q.name} error: ${error}`);
      workerError = true;
    });
  }

  return queues;
}

const workers: Worker[] = []
export const setupWorkers = () => {
  const container = setupContainer(logger);
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);

  // Setup the workers
  for (const { name, processor, concurrency } of processors) {
    const w = new Worker(name, processor, {
      connection: {
        url: process.env.REDIS_URL,
      },
      concurrency: concurrency ?? process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 1,
    });
    workers.push(w);

    logger.info(`Worker ${name} started with concurrency ${concurrency ?? process.env.WORKER_CONCURRENCY ?? 1}`);
  }

  for (const w of workers) {
    w.on('error', (error) => {
      logger.error(`Worker ${w.name} error: ${error}`);
      workerError = true;
    });
    w.on('failed', async (job, error) => {
      const taskId = job?.data?.taskId;
      if (typeof taskId !== 'string') {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, taskId, jobId: job.id, queueName: w.name }, 'Worker job failed');
      await tasksRepository.updateTask({
        taskId,
        status: 'failed',
        errors: [errorMessage],
      }).catch((updateError) => {
        logger.error({ error: updateError, taskId, jobId: job.id, queueName: w.name }, 'Error updating failed task from worker event');
      });
    });
  }

}

export const shutdownWorkers = async () => {
  logger.info('Shutting down workers...');

  for (const w of workers) {
    try {
      await w.close();
      logger.info(`Worker ${w.name} closed successfully`);
    } catch (error) {
      logger.error(`Error closing worker ${w.name}: ${error}`);
    }
  }

  logger.info('All workers shut down');
}