import { type Static, Type } from '@sinclair/typebox';
import { RDBExportPublicTargetSchema, RDBExportTargetSchema } from '../../../../global';

export const ScheduleTypeSchema = Type.Union([
  Type.Literal('RDBExport'),
]);
export type ScheduleType = Static<typeof ScheduleTypeSchema>;

export const ScheduleMinuteOfHourSchema = Type.Union([
  Type.Literal(0),
  Type.Literal(15),
  Type.Literal(30),
  Type.Literal(45),
]);
export type ScheduleMinuteOfHourType = Static<typeof ScheduleMinuteOfHourSchema>;

export const CreateRDBExportSchedulePayloadSchema = Type.Object({
  instanceId: Type.String(),
  username: Type.Optional(Type.String({
    pattern: '^[a-zA-Z0-9._-]+$',
    deprecated: true,
    description: 'Deprecated. Access is authorized by subscription role.',
  })),
  password: Type.Optional(Type.String({
    pattern: '^[a-zA-Z0-9._!\@\#\$\%\^\&\*]+$',
    deprecated: true,
    description: 'Deprecated. Access is authorized by subscription role.',
  })),
  target: Type.Optional(RDBExportTargetSchema),
});

export const RDBExportSchedulePayloadSchema = Type.Object({
  instanceId: Type.String(),
  target: Type.Optional(RDBExportTargetSchema),
});

export const PublicRDBExportSchedulePayloadSchema = Type.Object({
  instanceId: Type.String(),
  target: Type.Optional(RDBExportPublicTargetSchema),
});

export const CreateScheduleRequestBodySchema = Type.Object({
  type: Type.Literal('RDBExport'),
  payload: CreateRDBExportSchedulePayloadSchema,
  periodMinutes: Type.Integer({ minimum: 60, multipleOf: 15 }),
  minuteOfHour: ScheduleMinuteOfHourSchema,
  failureThreshold: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type CreateScheduleRequestBody = Static<typeof CreateScheduleRequestBodySchema>;

export const ScheduleDocumentSchema = Type.Object({
  scheduleId: Type.String(),
  requestorId: Type.String(),
  type: ScheduleTypeSchema,
  payload: RDBExportSchedulePayloadSchema,
  periodMinutes: Type.Integer({ minimum: 60, multipleOf: 15 }),
  minuteOfHour: ScheduleMinuteOfHourSchema,
  failureThreshold: Type.Integer({ minimum: 1 }),
  enabled: Type.Boolean(),
  nextRunAt: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
export type ScheduleDocument = Static<typeof ScheduleDocumentSchema>;

export const PublicScheduleSchema = Type.Object({
  scheduleId: Type.String(),
  requestorId: Type.String(),
  type: ScheduleTypeSchema,
  payload: PublicRDBExportSchedulePayloadSchema,
  periodMinutes: Type.Integer({ minimum: 60, multipleOf: 15 }),
  minuteOfHour: ScheduleMinuteOfHourSchema,
  failureThreshold: Type.Integer({ minimum: 1 }),
  enabled: Type.Boolean(),
  nextRunAt: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
export type PublicSchedule = Static<typeof PublicScheduleSchema>;

export const CreateScheduleResponseBodySchema = Type.Object({
  schedule: PublicScheduleSchema,
});
export type CreateScheduleResponseBody = Static<typeof CreateScheduleResponseBodySchema>;

export const ListSchedulesRequestQuerySchema = Type.Object({
  type: Type.Optional(ScheduleTypeSchema),
  instanceId: Type.Optional(Type.String()),
});
export type ListSchedulesRequestQuery = Static<typeof ListSchedulesRequestQuerySchema>;

export const ListSchedulesResponseBodySchema = Type.Object({
  data: Type.Array(PublicScheduleSchema),
});
export type ListSchedulesResponseBody = Static<typeof ListSchedulesResponseBodySchema>;

export const UpdateScheduleRequestParamsSchema = Type.Object({
  scheduleId: Type.String(),
});
export type UpdateScheduleRequestParams = Static<typeof UpdateScheduleRequestParamsSchema>;

export const UpdateScheduleRequestBodySchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
});
export type UpdateScheduleRequestBody = Static<typeof UpdateScheduleRequestBodySchema>;

export const UpdateScheduleResponseBodySchema = Type.Object({
  schedule: PublicScheduleSchema,
});
export type UpdateScheduleResponseBody = Static<typeof UpdateScheduleResponseBodySchema>;

export const TriggerSchedulesResponseBodySchema = Type.Object({
  triggered: Type.Array(Type.Object({ scheduleId: Type.String(), taskId: Type.String() })),
  skipped: Type.Array(Type.Object({ scheduleId: Type.String(), reason: Type.String() })),
  disabled: Type.Array(Type.Object({ scheduleId: Type.String(), reason: Type.String() })),
  failed: Type.Array(Type.Object({ scheduleId: Type.String(), error: Type.String() })),
});
export type TriggerSchedulesResponseBody = Static<typeof TriggerSchedulesResponseBodySchema>;