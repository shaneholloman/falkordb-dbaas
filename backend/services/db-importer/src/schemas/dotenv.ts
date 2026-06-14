import { type Static, Type } from '@sinclair/typebox';

export const EnvSchema = Type.Object({
  NODE_ENV: Type.String({ default: 'development' }),
  PORT: Type.Number({ default: 3010 }),
  RECAPTCHA_SECRET_KEY: Type.String({ default: '' }),
  GOOGLE_RECAPTCHA_SECRET_KEY: Type.String({ default: '' }),
  OMNISTRATE_EMAIL: Type.String({ default: '' }),
  OMNISTRATE_PASSWORD: Type.String({ default: '' }),
  OMNISTRATE_SERVICE_ID: Type.String({ default: '' }),
  OMNISTRATE_ENVIRONMENT_ID: Type.String({ default: '' }),
  EXPORT_BUCKET_NAME: Type.String({ default: '' }),
  SCHEDULE_TRIGGER_TOKEN: Type.String({ default: '' }),
  SCHEDULE_RDB_EXPORT_ALLOWED_TIERS: Type.String({ default: 'FalkorDB Pro,FalkorDB Enterprise' }),
  SCHEDULE_FAILURE_THRESHOLD: Type.Number({ default: 3 }),
  SCHEDULES_REPOSITORY_MONGODB_COLLECTION: Type.String({ default: 'schedules' }),
});

export type EnvSchemaType = Static<typeof EnvSchema>;
