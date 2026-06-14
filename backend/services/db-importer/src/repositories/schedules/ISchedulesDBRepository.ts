import { RDBExportTargetType } from '@falkordb/schemas/global';
import { ScheduleDocument, ScheduleType } from '@falkordb/schemas/services/import-export-rdb/v1';

export type SchedulePayloadByType = {
  RDBExport: {
    instanceId: string;
    target?: RDBExportTargetType;
  };
};

export abstract class ISchedulesDBRepository {
  abstract createSchedule(schedule: {
    requestorId: string;
    type: ScheduleType;
    payload: SchedulePayloadByType[ScheduleType];
    periodMinutes: number;
    minuteOfHour: 0 | 15 | 30 | 45;
    failureThreshold: number;
    nextRunAt: string;
  }): Promise<ScheduleDocument>;

  abstract listSchedules(filters?: { type?: ScheduleType; instanceId?: string }): Promise<ScheduleDocument[]>;

  abstract getSchedule(scheduleId: string): Promise<ScheduleDocument | null>;

  abstract listDueSchedules(now: Date, limit?: number): Promise<ScheduleDocument[]>;

  abstract updateSchedule(scheduleId: string, update: Partial<ScheduleDocument>): Promise<ScheduleDocument>;

  abstract updateNextRunAt(scheduleId: string, nextRunAt: string): Promise<ScheduleDocument>;
}