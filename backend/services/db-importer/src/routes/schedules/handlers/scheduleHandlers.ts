import { FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ApiError } from '@falkordb/errors';
import {
  CreateScheduleRequestBody,
  CreateScheduleResponseBody,
  DeleteScheduleRequestParams,
  DeleteScheduleResponseBody,
  ListSchedulesRequestQuery,
  ListSchedulesResponseBody,
  TriggerSchedulesResponseBody,
  UpdateScheduleRequestBody,
  UpdateScheduleRequestParams,
  UpdateScheduleResponseBody,
} from '@falkordb/schemas/services/import-export-rdb/v1';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { ISchedulesDBRepository } from '../../../repositories/schedules';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import { ScheduleController } from '../controllers/ScheduleController';
import { K8sRepository } from '../../../repositories/k8s/K8sRepository';
import { getRequestorId } from './auth';

const makeScheduleController = (request: FastifyRequest): ScheduleController => {
  const schedulesRepository = request.diScope.resolve<ISchedulesDBRepository>(ISchedulesDBRepository.name);
  const tasksRepository = request.diScope.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const omnistrateRepository = request.diScope.resolve<OmnistrateRepository>(OmnistrateRepository.name);
  const k8sRepository = request.diScope.resolve<K8sRepository>(K8sRepository.name);
  const taskQueueRepository = request.diScope.resolve<ITaskQueueRepository>(ITaskQueueRepository.name);

  return new ScheduleController(
    schedulesRepository,
    tasksRepository,
    omnistrateRepository,
    k8sRepository,
    taskQueueRepository,
    request.server.config.EXPORT_BUCKET_NAME,
    request.server.config.IMPORT_BUCKET_NAME,
    {
      defaultFailureThreshold: request.server.config.SCHEDULE_FAILURE_THRESHOLD,
      rdbExportAllowedTiers: request.server.config.SCHEDULE_RDB_EXPORT_ALLOWED_TIERS,
      rdbExportMaxPerInstance: request.server.config.SCHEDULE_RDB_EXPORT_MAX_PER_INSTANCE,
    },
    { logger: request.log },
  );
};

export const createScheduleHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Body: CreateScheduleRequestBody;
  Reply: CreateScheduleResponseBody;
}> = async (request, reply) => {
  try {
    const requestorId = getRequestorId((request.headers as unknown)?.['authorization'] as string);
    const controller = makeScheduleController(request);
    const schedule = await controller.createSchedule({
      requestorId,
      type: request.body.type,
      payload: request.body.payload,
      periodMinutes: request.body.periodMinutes,
      minuteOfHour: request.body.minuteOfHour,
      failureThreshold: request.body.failureThreshold,
    });
    reply.status(201).send({ schedule });
  } catch (error) {
    request.log.error(error, 'Error creating schedule');
    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }
    throw error;
  }
};

export const listSchedulesHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Querystring: ListSchedulesRequestQuery;
  Reply: ListSchedulesResponseBody;
}> = async (request, reply) => {
  try {
    const requestorId = getRequestorId((request.headers as unknown)?.['authorization'] as string);
    const controller = makeScheduleController(request);
    const data = await controller.listSchedules(requestorId, request.query);
    reply.send({ data });
  } catch (error) {
    request.log.error(error, 'Error listing schedules');
    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }
    throw error;
  }
};

export const updateScheduleHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Params: UpdateScheduleRequestParams;
  Body: UpdateScheduleRequestBody;
  Reply: UpdateScheduleResponseBody;
}> = async (request, reply) => {
  try {
    const requestorId = getRequestorId((request.headers as unknown)?.['authorization'] as string);
    const controller = makeScheduleController(request);
    const schedule = await controller.updateSchedule(requestorId, request.params.scheduleId, request.body);
    reply.send({ schedule });
  } catch (error) {
    request.log.error(error, 'Error updating schedule');
    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }
    throw error;
  }
};

export const deleteScheduleHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Params: DeleteScheduleRequestParams;
  Reply: DeleteScheduleResponseBody;
}> = async (request, reply) => {
  try {
    const requestorId = getRequestorId((request.headers as unknown)?.['authorization'] as string);
    const controller = makeScheduleController(request);
    const schedule = await controller.deleteSchedule(requestorId, request.params.scheduleId);
    reply.send({ schedule });
  } catch (error) {
    request.log.error(error, 'Error deleting schedule');
    if (error instanceof ApiError) {
      throw error.toFastify(request.server);
    }
    throw error;
  }
};

export const triggerSchedulesHandler: RouteHandlerMethod<undefined, undefined, undefined, {
  Reply: TriggerSchedulesResponseBody;
}> = async (request, reply) => {
  const expectedToken = request.server.config.SCHEDULE_TRIGGER_TOKEN;
  const providedToken = request.headers['x-scheduler-token'];
  if (!expectedToken || providedToken !== expectedToken) {
    throw ApiError.unauthorized('Invalid scheduler token', 'INVALID_SCHEDULER_TOKEN').toFastify(request.server);
  }

  const controller = makeScheduleController(request);
  const result = await controller.triggerDueSchedules();
  reply.send(result);
};