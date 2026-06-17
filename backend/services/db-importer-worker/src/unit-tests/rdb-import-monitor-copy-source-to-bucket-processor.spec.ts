import { DelayedError } from 'bullmq';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';
import RdbImportMonitorCopySourceToBucketProcessor from '../processors/RdbImportMonitorCopySourceToBucketProcessor';

const mockResolve = jest.fn();

jest.mock('../container', () => ({
  setupContainer: jest.fn(() => ({
    resolve: mockResolve,
  })),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
};

describe('RDB import monitor copy source to bucket processor', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const setup = (jobStatus: 'pending' | 'completed' | 'failed', logs?: string) => {
    const tasksRepository = {
      updateTask: jest.fn().mockResolvedValue(undefined),
    };
    const k8sRepository = {
      getJobStatus: jest.fn().mockResolvedValue([jobStatus, logs]),
    };

    mockResolve.mockImplementation((name: string) => {
      switch (name) {
        case 'logger':
          return logger;
        case ITasksDBRepository.name:
          return tasksRepository;
        case K8sRepository.name:
          return k8sRepository;
        default:
          throw new Error(`Unexpected dependency: ${name}`);
      }
    });

    return { tasksRepository, k8sRepository };
  };

  const makeJob = () => ({
    id: 'job-id',
    data: {
      taskId: 'task-id',
      projectId: 'ctrl-project',
      cloudProvider: 'gcp',
      clusterId: 'ctrl-cluster',
      region: 'us-central1',
      namespace: 'api',
    },
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  it('delays while the Kubernetes copy job is pending', async () => {
    const { k8sRepository, tasksRepository } = setup('pending');
    const job = makeJob();

    await expect(RdbImportMonitorCopySourceToBucketProcessor.processor(job as never, 'token' as never)).rejects.toBeInstanceOf(DelayedError);

    expect(k8sRepository.getJobStatus).toHaveBeenCalledWith(
      'ctrl-project',
      'gcp',
      'ctrl-cluster',
      'us-central1',
      'api',
      'task-id-copy-source-to-bucket',
    );
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    expect(tasksRepository.updateTask).not.toHaveBeenCalled();
  });

  it('continues the pipeline after the Kubernetes copy job completes', async () => {
    const { tasksRepository } = setup('completed');
    const job = makeJob();

    await expect(RdbImportMonitorCopySourceToBucketProcessor.processor(job as never, 'token' as never)).resolves.toEqual({ success: true });

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(tasksRepository.updateTask).not.toHaveBeenCalled();
  });

  it('marks the task failed when the Kubernetes copy job fails', async () => {
    const { tasksRepository } = setup('failed', 'copy failed');
    const job = makeJob();

    await expect(RdbImportMonitorCopySourceToBucketProcessor.processor(job as never, 'token' as never)).rejects.toThrow('copy failed');

    expect(tasksRepository.updateTask).toHaveBeenCalledWith({
      taskId: 'task-id',
      errors: ['K8s Job task-id-copy-source-to-bucket failed: copy failed'],
      status: 'failed',
    });
  });
});
