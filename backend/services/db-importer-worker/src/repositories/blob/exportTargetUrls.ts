import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Storage } from '@google-cloud/storage';
import { RDBExportOutputTargetType, RDBExportTargetType } from '@falkordb/schemas/global';

const isCustomTarget = (target?: RDBExportTargetType): target is Extract<RDBExportTargetType, { type: 'gcs' | 's3' }> => {
  return target?.type === 'gcs' || target?.type === 's3';
};

export const getExportTargetWriteUrl = async (
  target: RDBExportTargetType | undefined,
  fileName: string,
  contentType: string,
  expiresIn: number,
): Promise<string | undefined> => {
  if (!isCustomTarget(target)) {
    return undefined;
  }

  if (target.type === 'gcs') {
    const storage = new Storage({
      projectId: target.credentials.project_id as string | undefined,
      credentials: target.credentials,
    });

    const [writeUrl] = await storage
      .bucket(target.bucketName)
      .file(fileName)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresIn,
        contentType,
      });

    return writeUrl;
  }

  const s3Client = new S3Client({
    region: target.region,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
      sessionToken: target.sessionToken,
    },
  });

  return getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: target.bucketName,
      Key: fileName,
      ContentType: contentType,
    }),
    { expiresIn: Math.floor(expiresIn / 1000) },
  );
};

export const makeExportOutputTarget = (
  target: RDBExportTargetType | undefined,
  fileName: string,
): RDBExportOutputTargetType | undefined => {
  if (!isCustomTarget(target)) {
    return undefined;
  }

  if (target.type === 'gcs') {
    return {
      type: 'gcs',
      bucketName: target.bucketName,
      fileName,
      path: `gs://${target.bucketName}/${fileName}`,
    };
  }

  return {
    type: 's3',
    bucketName: target.bucketName,
    key: fileName,
    region: target.region,
    path: `s3://${target.bucketName}/${fileName}`,
  };
};