import { Static, TSchema } from '@sinclair/typebox';
import { FlowChildJob, FlowJob, JobsOptions, Processor } from 'bullmq';
import RdbExportRequestReadSignedURLProcessor from './RdbExportRequestReadSignedURL';
import RdbExportSendSaveCommandProcessor from './RdbExportSendSaveCommandProcessor';
import RdbExportMonitorSaveProgressProcessor from './RdbExportMonitorSaveProgressProcessor';
import RdbExportCopyRDBToBucketProcessor from './RdbExportCopyRDBToBucketProcessor';
import RdbExportMonitorRDBMergeProcessor from './RdbExportMonitorRDBMergeProcessor';
import RdbExportRequestRDBMergeProcessor from './RdbExportRequestRDBMergeProcessor';
import PlaceholderProcessor from './PlaceholderProcessor';
import RdbImportCopyInstanceSourceToBucketProcessor from './RdbImportCopyInstanceSourceToBucketProcessor';
import RdbImportCopySourceToBucketProcessor from './RdbImportCopySourceToBucketProcessor';
import RdbImportDeleteLocalBackupProcessor from './RdbImportDeleteLocalBackupProcessor';
import RdbImportFlushInstanceProcessor from './RdbImportFlushInstanceProcessor';
import RdbImportMakeLocalBackupProcessor from './RdbImportMakeLocalBackupProcessor';
import RdbImportMonitorCopySourceToBucketProcessor from './RdbImportMonitorCopySourceToBucketProcessor';
import RdbImportMonitorFormatValidationProcessor from './RdbImportMonitorFormatValidationProcessor';
import RdbImportMonitorImportRDBProcessor from './RdbImportMonitorImportRDBProcessor';
import RdbImportMonitorSaveProgressProcessor from './RdbImportMonitorSaveProgressProcessor';
import RdbImportMonitorSizeValidationProcessor from './RdbImportMonitorSizeValidationProcessor';
import RdbImportMonitorSourceRDBMergeProcessor from './RdbImportMonitorSourceRDBMergeProcessor';
import RdbImportRdbFormatValidationProcessor from './RdbImportRdbFormatValidationProcessor';
import RdbImportRdbSizeValidationProcessor from './RdbImportRdbSizeValidationProcessor';
import RdbImportRecoverFailedImportProcessor from './RdbImportRecoverFailedImportProcessor';
import RdbImportRequestRdbImportProcessor from './RdbImportRequestRdbImportProcessor';
import RdbImportRequestSourceRDBMergeProcessor from './RdbImportRequestSourceRDBMergeProcessor';
import RdbImportSendSaveCommandProcessor from './RdbImportSendSaveCommandProcessor';
import RdbImportValidateImportKeyNumberProcessor from './RdbImportValidateImportKeyNumberProcessor';

type IProcessorType = {
  name: string;
  processor: Processor;
  concurrency?: number;
  schema: TSchema;
}

export default [
  RdbExportRequestReadSignedURLProcessor,
  RdbExportSendSaveCommandProcessor,
  RdbExportMonitorSaveProgressProcessor,
  RdbExportCopyRDBToBucketProcessor,
  RdbExportMonitorRDBMergeProcessor,
  RdbExportRequestRDBMergeProcessor,
  PlaceholderProcessor,
  RdbImportCopyInstanceSourceToBucketProcessor,
  RdbImportCopySourceToBucketProcessor,
  RdbImportMonitorCopySourceToBucketProcessor,
  RdbImportDeleteLocalBackupProcessor,
  RdbImportFlushInstanceProcessor,
  RdbImportMakeLocalBackupProcessor,
  RdbImportMonitorFormatValidationProcessor,
  RdbImportMonitorImportRDBProcessor,
  RdbImportMonitorSaveProgressProcessor,
  RdbImportMonitorSizeValidationProcessor,
  RdbImportMonitorSourceRDBMergeProcessor,
  RdbImportRdbFormatValidationProcessor,
  RdbImportRdbSizeValidationProcessor,
  RdbImportRecoverFailedImportProcessor,
  RdbImportRequestRdbImportProcessor,
  RdbImportRequestSourceRDBMergeProcessor,
  RdbImportSendSaveCommandProcessor,
  RdbImportValidateImportKeyNumberProcessor,
] as IProcessorType[];

function makeJobNode<T extends IProcessorType>(
  processor: T,
  data?: Static<T['schema']>,
  opts: JobsOptions = { failParentOnFailure: true },
  children?: FlowChildJob[],
): FlowJob {
  return {
    name: processor.name,
    queueName: processor.name,
    data,
    children,
    opts,
  }
}

export {
  makeJobNode,
  RdbExportRequestReadSignedURLProcessor,
  RdbExportSendSaveCommandProcessor,
  RdbExportMonitorSaveProgressProcessor,
  RdbExportCopyRDBToBucketProcessor,
  RdbExportMonitorRDBMergeProcessor,
  RdbExportRequestRDBMergeProcessor,
  PlaceholderProcessor,
  RdbImportCopyInstanceSourceToBucketProcessor,
  RdbImportCopySourceToBucketProcessor,
  RdbImportMonitorCopySourceToBucketProcessor,
  RdbImportDeleteLocalBackupProcessor,
  RdbImportFlushInstanceProcessor,
  RdbImportMakeLocalBackupProcessor,
  RdbImportMonitorFormatValidationProcessor,
  RdbImportMonitorImportRDBProcessor,
  RdbImportMonitorSaveProgressProcessor,
  RdbImportMonitorSizeValidationProcessor,
  RdbImportMonitorSourceRDBMergeProcessor,
  RdbImportRdbFormatValidationProcessor,
  RdbImportRdbSizeValidationProcessor,
  RdbImportRecoverFailedImportProcessor,
  RdbImportRequestRdbImportProcessor,
  RdbImportRequestSourceRDBMergeProcessor,
  RdbImportSendSaveCommandProcessor,
  RdbImportValidateImportKeyNumberProcessor,
}