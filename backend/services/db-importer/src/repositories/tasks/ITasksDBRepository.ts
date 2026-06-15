import { RDBExportTaskPayloadType, RDBImportTaskPayloadType, TaskDocumentType, TaskStatusType, TaskTypesType } from "@falkordb/schemas/global";

export abstract class ITasksDBRepository {

  abstract createTask(
    type: TaskTypesType,
    payload: RDBExportTaskPayloadType | RDBImportTaskPayloadType,
    opts?: { scheduleId?: string },
  ): Promise<TaskDocumentType>;

  abstract listTasks(
    instanceId: string,
    opts?: {
      page?: number,
      pageSize?: number,
      status?: TaskStatusType[],
      types?: TaskTypesType[],
    }
  ): Promise<{
    data: TaskDocumentType[];
    page: number;
    pageSize: number;
    total: number;
  }>;

  abstract listTasksByScheduleId(
    scheduleId: string,
    opts?: {
      status?: TaskStatusType[],
      types?: TaskTypesType[],
    }
  ): Promise<TaskDocumentType[]>;

  abstract updateTask(
    task: Partial<TaskDocumentType> & {
      taskId: string;
      errors?: string[];
    }
  ): Promise<TaskDocumentType>;

  abstract getTaskById(taskId: string): Promise<TaskDocumentType | null>;
}