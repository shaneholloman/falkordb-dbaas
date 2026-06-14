import assert from 'assert';
import { FastifyBaseLogger } from 'fastify';
import { MongoClient } from 'mongodb';
import { Value } from '@sinclair/typebox/value';
import { ScheduleDocument, ScheduleDocumentSchema, ScheduleType } from '@falkordb/schemas/services/import-export-rdb/v1';
import { sanitizeForLogging } from '@falkordb/schemas/global';
import { ISchedulesDBRepository, SchedulePayloadByType } from './ISchedulesDBRepository';

export class SchedulesDBMongoRepository implements ISchedulesDBRepository {
  private _client: MongoClient = null;

  private _db: string = process.env.TASKS_REPOSITORY_MONGODB_DB ?? process.env.SERVICE_NAME ?? 'db-importer-worker';

  private _collection: string = process.env.SCHEDULES_REPOSITORY_MONGODB_COLLECTION ?? 'schedules';

  constructor(private _options: { logger: FastifyBaseLogger }) {
    assert(process.env.MONGODB_URI, 'SchedulesDBMongoRepository: MongoDB URI is required');
    this._client = new MongoClient(process.env.MONGODB_URI);

    this._client.connect()
      .then(() => this._options.logger.info('MongoDB schedules connection established'))
      .then(() => this._client.db(this._db).createIndex(this._collection, 'scheduleId', { unique: true }))
      .then(() => this._client.db(this._db).collection(this._collection).createIndex({ enabled: 1, nextRunAt: 1 }))
      .then(() => this._client.db(this._db).collection(this._collection).createIndex({ type: 1, 'payload.instanceId': 1 }));
  }

  async createSchedule(schedule: {
    requestorId: string;
    type: ScheduleType;
    payload: SchedulePayloadByType[ScheduleType];
    periodMinutes: number;
    minuteOfHour: 0 | 15 | 30 | 45;
    failureThreshold: number;
    nextRunAt: string;
  }): Promise<ScheduleDocument> {
    this._options.logger.info({ schedule: sanitizeForLogging(schedule) }, 'Creating schedule');
    const now = new Date().toISOString();
    const document: ScheduleDocument = {
      ...schedule,
      scheduleId: crypto.randomUUID(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    await this._client.db(this._db).collection<ScheduleDocument>(this._collection).insertOne(document);
    return Value.Cast(ScheduleDocumentSchema, document);
  }

  async listSchedules(filters: { type?: ScheduleType; instanceId?: string } = {}): Promise<ScheduleDocument[]> {
    const query = {};
    if (filters.type) {
      query['type'] = filters.type;
    }
    if (filters.instanceId) {
      query['payload.instanceId'] = filters.instanceId;
    }
    const result = await this._client.db(this._db).collection<ScheduleDocument>(this._collection)
      .find(query)
      .sort({ updatedAt: -1 })
      .toArray();
    return result.map((schedule) => Value.Cast(ScheduleDocumentSchema, schedule));
  }

  async getSchedule(scheduleId: string): Promise<ScheduleDocument | null> {
    const schedule = await this._client.db(this._db).collection<ScheduleDocument>(this._collection).findOne({ scheduleId });
    return schedule ? Value.Cast(ScheduleDocumentSchema, schedule) : null;
  }

  async listDueSchedules(now: Date, limit = 50): Promise<ScheduleDocument[]> {
    const result = await this._client.db(this._db).collection<ScheduleDocument>(this._collection)
      .find({ enabled: true, nextRunAt: { $lte: now.toISOString() } })
      .sort({ nextRunAt: 1 })
      .limit(limit)
      .toArray();
    return result.map((schedule) => Value.Cast(ScheduleDocumentSchema, schedule));
  }

  async updateSchedule(scheduleId: string, update: Partial<ScheduleDocument>): Promise<ScheduleDocument> {
    const result = await this._client.db(this._db).collection<ScheduleDocument>(this._collection).findOneAndUpdate(
      { scheduleId },
      { $set: { ...update, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      throw new Error(`Schedule ${scheduleId} not found`);
    }
    return Value.Cast(ScheduleDocumentSchema, result);
  }

  async updateNextRunAt(scheduleId: string, nextRunAt: string): Promise<ScheduleDocument> {
    return this.updateSchedule(scheduleId, {
      nextRunAt,
    });
  }
}