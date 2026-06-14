import { FastifyBaseLogger } from 'fastify';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { RDBExportTargetType } from '@falkordb/schemas/global';
import assert = require('assert');
import { ApiError } from '@falkordb/errors';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import { RDBExportTaskService } from '../../../services/RDBExportTaskService';

export class ExportRDBController {
  constructor(
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
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
    target = {},
  }: {
    requestorId: string;
    instanceId: string;
    username?: string;
    password?: string;
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

    return exportTaskService.createAndSubmitTask({ instance, target });
  }
}
