import fp from 'fastify-plugin';
import {
  CreateScheduleRequestBodySchema,
  CreateScheduleResponseBodySchema,
  ListSchedulesRequestQuerySchema,
  ListSchedulesResponseBodySchema,
  TriggerSchedulesResponseBodySchema,
  UpdateScheduleRequestBodySchema,
  UpdateScheduleRequestParamsSchema,
  UpdateScheduleResponseBodySchema,
} from '@falkordb/schemas/services/import-export-rdb/v1';
import {
  createScheduleHandler,
  listSchedulesHandler,
  triggerSchedulesHandler,
  updateScheduleHandler,
} from './handlers/scheduleHandlers';

export default fp(
  async function handler(fastify) {
    fastify.post(
      '/schedules',
      {
        preHandler: async (request) => {
          await fastify.authenticateOmnistrate(request);
        },
        schema: {
          tags: ['schedules'],
          body: CreateScheduleRequestBodySchema,
          response: { 201: CreateScheduleResponseBodySchema },
          security: [{ bearerAuth: [] }],
        },
      },
      createScheduleHandler,
    );

    fastify.get(
      '/schedules',
      {
        preHandler: async (request) => {
          await fastify.authenticateOmnistrate(request);
        },
        schema: {
          tags: ['schedules'],
          querystring: ListSchedulesRequestQuerySchema,
          response: { 200: ListSchedulesResponseBodySchema },
          security: [{ bearerAuth: [] }],
        },
      },
      listSchedulesHandler,
    );

    fastify.patch(
      '/schedules/:scheduleId',
      {
        preHandler: async (request) => {
          await fastify.authenticateOmnistrate(request);
        },
        schema: {
          tags: ['schedules'],
          params: UpdateScheduleRequestParamsSchema,
          body: UpdateScheduleRequestBodySchema,
          response: { 200: UpdateScheduleResponseBodySchema },
          security: [{ bearerAuth: [] }],
        },
      },
      updateScheduleHandler,
    );

    fastify.post(
      '/schedules/trigger',
      {
        schema: {
          tags: ['schedules'],
          response: { 200: TriggerSchedulesResponseBodySchema },
        },
      },
      triggerSchedulesHandler,
    );
  },
  {
    name: 'schedule-routes',
  },
);