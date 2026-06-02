import { RouteHandlerMethod } from 'fastify';
import {
  ListRDBTasksRequestQueryType,
  ListRDBTasksResponseType,
} from '@falkordb/schemas/services/import-export-rdb/v1';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { ApiError } from '@falkordb/errors';
import { decode, JwtPayload } from 'jsonwebtoken';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { ExportRDBTaskType, PublicTaskDocumentType, RDBExportPublicTargetType, RDBExportTargetType, TaskDocumentType } from '@falkordb/schemas/global';

const sanitizeExportTarget = (target?: RDBExportTargetType): RDBExportPublicTargetType | undefined => {
  switch (target?.type) {
    case 'gcs':
      return {
        type: 'gcs',
        bucketName: target.bucketName,
        fileName: target.fileName,
      };
    case 's3':
      return {
        type: 's3',
        bucketName: target.bucketName,
        key: target.key,
        region: target.region,
      };
    case 'default':
      return { type: 'default' };
    default:
      return undefined;
  }
};

const sanitizeTaskDocument = (task: TaskDocumentType): PublicTaskDocumentType => {
  if (task.type !== 'SingleShardRDBExport' && task.type !== 'MultiShardRDBExport') {
    return task;
  }

  const exportTask = task as ExportRDBTaskType;
  const target = sanitizeExportTarget(exportTask.payload.destination.target);

  return {
    ...exportTask,
    payload: {
      ...exportTask.payload,
      destination: {
        ...exportTask.payload.destination,
        target,
      },
    },
  };
};

export const listTasksHandler: RouteHandlerMethod<
  undefined,
  undefined,
  undefined,
  {
    Querystring: ListRDBTasksRequestQueryType;
    Reply: ListRDBTasksResponseType;
  }
> = async (request, reply) => {
  const logger = request.log;
  const tasksRepository = request.diScope.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const omnistrateRepository = request.diScope.resolve<OmnistrateRepository>(OmnistrateRepository.name);

  const { page, pageSize, instanceId } = request.query;

  try {
    const { userID } = decode(
      ((request.headers as unknown)?.['authorization'] as string)?.split(' ').pop(),
    ) as JwtPayload;
    const hasAccess = await omnistrateRepository.checkIfUserHasAccessToInstance(userID, undefined, instanceId, [
      'root',
      'editor',
      'reader',
    ]);
    if (!hasAccess) {
      throw ApiError.forbidden("You don't have access to this instance", 'FORBIDDEN');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }

    logger.error(error, 'Error decoding token');
    throw ApiError.unauthorized('Invalid token', 'INVALID_TOKEN').toFastify(request.server);
  }

  try {
    const data = await tasksRepository.listTasks(instanceId, {
      page,
      pageSize,
    });

    reply.send({
      ...data,
      data: data.data.map(sanitizeTaskDocument),
    });
  } catch (error) {
    logger.error(error, 'Error listing tasks');

    throw ApiError.internalServerError('Error listing tasks', 'INTERNAL_ERROR').toFastify(request.server);
  }
};
