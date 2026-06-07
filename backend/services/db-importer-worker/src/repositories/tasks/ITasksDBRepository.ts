import { RDBTaskType } from "../../schemas/rdb-task";

export abstract class ITasksDBRepository {

  abstract getTaskById(taskId: string): Promise<RDBTaskType>;

  abstract updateTask(task: Partial<RDBTaskType> & { taskId: string; errors?: string[] }): Promise<void>;

}