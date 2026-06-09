import assert from "assert";
import { ITasksDBRepository } from "./ITasksDBRepository";
import { MongoClient } from 'mongodb';
import { RDBTask, RDBTaskType } from "../../schemas/rdb-task";
import { Logger } from "pino";
import { flatten } from "../../utils/flatten";
import { sanitizeForLogging } from "@falkordb/schemas/global";

export class TasksDBMongoRepository implements ITasksDBRepository {

  private _client: MongoClient = null;

  private _db: string = process.env.TASKS_REPOSITORY_MONGODB_DB ?? process.env.SERVICE_NAME ?? 'db-importer-worker';

  private _collection: string = process.env.TASKS_REPOSITORY_MONGODB_COLLECTION ?? 'tasks';

  constructor(private _options: { logger: Logger }) {
    assert(process.env.MONGODB_URI, 'TasksDBMongoRepository: MongoDB URI is required');
    this._client = new MongoClient(process.env.MONGODB_URI);

    this._client.connect()
      .then(() => this._client.db(this._db).createIndex(this._collection, 'taskId', { unique: true }))

  }

  async getTaskById(taskId: string) {
    const db = this._client.db(this._db);
    const task = await db.collection(this._collection).findOne({ taskId });
    this._options.logger.info({ taskId, task: sanitizeForLogging(task) }, 'getTaskById');
    if (!task) {
      return null;
    }
    delete task._id; // Remove MongoDB's default _id field
    try {
      return RDBTask.validateSync(task, {
        stripUnknown: true,
      }) as RDBTaskType;
    } catch (error) {
      if (error && typeof error === 'object') {
        const validationError = error as { value?: unknown; params?: unknown };
        validationError.value = sanitizeForLogging(validationError.value);
        validationError.params = sanitizeForLogging(validationError.params);
      }
      throw error;
    }
  }

  async updateTask(task: Partial<RDBTaskType> & { taskId: string; errors?: string[] }) {
    const db = this._client.db(this._db);
    task.updatedAt = new Date().toISOString();
    // separate `errors` field handling to avoid overwriting
    const { errors = [], ...rest } = task;
    await db.collection(this._collection).updateOne({ taskId: task.taskId }, { $set: flatten(rest), $addToSet: { errors: { $each: errors } } });
  }

}