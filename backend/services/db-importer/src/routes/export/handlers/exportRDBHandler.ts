import { RouteHandlerMethod } from "fastify";
import { ExportRDBRequestBody, ExportRDBResponseBody } from '@falkordb/schemas/services/import-export-rdb/v1';
import { ApiError } from "@falkordb/errors";
import { ExportRDBController } from "../controllers/ExportRDBController";
import { ITasksDBRepository } from "../../../repositories/tasks";
import { OmnistrateRepository } from "../../../repositories/omnistrate/OmnistrateRepository";
import { decode, JwtPayload } from 'jsonwebtoken';
import { ITaskQueueRepository } from "../../../repositories/tasksQueue/ITaskQueueRepository";

export const exportRDBHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Body: ExportRDBRequestBody,
  Reply: ExportRDBResponseBody,
}> = async (request, reply) => {
  const {
    instanceId,
    target,
  } = request.body;

  const logger = request.log;

  const tasksRepository = request.diScope.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const omnistrateRepository = request.diScope.resolve<OmnistrateRepository>(OmnistrateRepository.name);
  const taskQueueRepository = request.diScope.resolve<ITaskQueueRepository>(ITaskQueueRepository.name);

  const controller = new ExportRDBController(
    tasksRepository,
    omnistrateRepository,
    taskQueueRepository,
    request.server.config.EXPORT_BUCKET_NAME,
    {
      logger,
    }
  );

  try {
    const { userID } = decode(((request.headers as unknown)?.['authorization'] as string)?.split(' ').pop()) as JwtPayload;
    const { taskId } = await controller.exportRDB({
      requestorId: userID,
      instanceId,
      target,
    });

    reply.status(202).send({
      taskId,
    });
  } catch (error) {
    logger.error(error, "Error exporting RDB");

    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }

    throw error;
  }
}