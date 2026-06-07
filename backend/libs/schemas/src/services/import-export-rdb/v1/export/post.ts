import { type Static, Type } from '@sinclair/typebox';
import { RDBExportTargetSchema } from '../../../../global';

export const ExportRDBRequestBodySchema = Type.Object({
  instanceId: Type.String(),
  username: Type.Optional(Type.String({
    pattern: "^[a-zA-Z0-9._-]+$",
  })),
  password: Type.Optional(Type.String({
    pattern: "^[a-zA-Z0-9._!\@\#\$\%\^\&\*-]+$"
  })),
  target: Type.Optional(RDBExportTargetSchema),
});

export type ExportRDBRequestBody = Static<typeof ExportRDBRequestBodySchema>;

export const ExportRDBResponseBodySchema = Type.Object({
  taskId: Type.String(),
});
export type ExportRDBResponseBody = Static<typeof ExportRDBResponseBodySchema>;