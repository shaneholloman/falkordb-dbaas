import { FastifyBaseLogger } from 'fastify';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { K8sRepository } from '../../../repositories/k8s/K8sRepository';
import { RDBExportTargetType } from '@falkordb/schemas/global';
import assert = require('assert');
import { ApiError } from '@falkordb/errors';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import { RDBExportTaskService } from '../../../services/RDBExportTaskService';

export class ExportRDBController {
  constructor(
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
    private k8sRepository: K8sRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _exportBucketName: string,
    private _opts: {
      logger: FastifyBaseLogger;
    },
  ) {
    assert(_exportBucketName, 'ExportRDBController: exportBucketName is required');
  }

  private _makeExportTaskService(): RDBExportTaskService {
    return new RDBExportTaskService(
      this.tasksRepository,
      this.omnistrateRepository,
      this.taskQueueRepository,
      this._exportBucketName,
      this._opts,
    );
  }

  async exportRDB({
    requestorId,
    instanceId,
    username,
    password,
    target = {},
  }: {
    requestorId: string;
    instanceId: string;
    username: string;
    password: string;
    target?: RDBExportTargetType;
  }): Promise<{ taskId: string }> {
    const exportTaskService = this._makeExportTaskService();
    const instance = await exportTaskService.getExportableInstance(instanceId);

    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, instance, undefined, [
      'root',
      'editor',
      'reader',
    ]);

    if (!hasAccess) {
      throw ApiError.unauthorized('User does not have access to this instance', 'USER_NOT_AUTHORIZED');
    }

    const podId = exportTaskService.resolvePrimaryPodId(instance);

    // Validate credentials with k8s repository
    let isAdmin = false;
    try {
      isAdmin = await this.k8sRepository.isUserAdmin(
        instance.cloudProvider,
        instance.clusterId,
        instance.region,
        instanceId,
        podId,
        username,
        password,
        instance.tls,
      );
    } catch (error) {
      this._opts.logger.error({ error }, 'Error validating credentials');
      console.error(error);
      throw ApiError.internalServerError('Error validating credentials', 'CREDENTIALS_ERROR');
    }

    if (!isAdmin) {
      throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    return exportTaskService.createAndSubmitTask({ instance, target });
  }
}
