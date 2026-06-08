import { ExportRDBTaskType, ImportRDBTaskType, MultiShardRDBExportPayloadType, sanitizeForLogging } from "@falkordb/schemas/global";
import { FastifyBaseLogger } from "fastify";
import { FlowChildJob, FlowJob, FlowProducer, JobsOptions } from 'bullmq';
import { Static, TSchema } from "@sinclair/typebox";
import { ProcessorsSchemaMap, RdbExportTaskNames, RdbImportTaskNames } from "@falkordb/schemas/services/db-importer-worker/v1";
import { Value } from "@sinclair/typebox/value";
import assert = require("assert");
import { ITaskQueueRepository } from "./ITaskQueueRepository";

export class TaskQueueBullMQRepository implements ITaskQueueRepository {

  private _producer: FlowProducer;

  constructor(
    private _opts: {
      logger: FastifyBaseLogger;
    },
  ) {
    this._producer = new FlowProducer({
      connection: {
        url: process.env.REDIS_URL,
      },
    });
  }

  _makeJobNode<T extends TSchema>(
    name: RdbExportTaskNames | RdbImportTaskNames,
    schema: T,
    data: Static<T>,
    opts: JobsOptions = { failParentOnFailure: true },
    children?: FlowChildJob[],
  ): FlowJob {
    this._opts.logger.debug({ name, data: sanitizeForLogging(data) }, 'Creating job node');
    Value.Assert(schema, data);
    return {
      name: name,
      queueName: name,
      data,
      children,
      opts,
    }
  }

  private _isCustomerExportTarget(task: ExportRDBTaskType): boolean {
    return task.payload.destination.target?.type === 'gcs' || task.payload.destination.target?.type === 's3';
  }

  _createSingleShardRDBExportFlow(
    task: ExportRDBTaskType,
  ): FlowJob {
    this._opts.logger.debug(`Creating single shard RDB export flow for task: ${task.taskId}`);
    const copyRdbToBucketJob = this._makeJobNode(
      RdbExportTaskNames.RdbExportCopyRdbToBucket,
      ProcessorsSchemaMap[RdbExportTaskNames.RdbExportCopyRdbToBucket],
      {
        taskId: task.taskId,
        cloudProvider: task.payload.cloudProvider,
        clusterId: task.payload.clusterId,
        region: task.payload.region,
        instanceId: task.payload.instanceId,
        podId: task.payload.podId,
        bucketName: task.payload.destination.bucketName,
        fileName: task.payload.destination.fileName,
      },
      {
        failParentOnFailure: true,
      },
      [
        this._makeJobNode(
          RdbExportTaskNames.RdbExportMonitorSaveProgress,
          ProcessorsSchemaMap[RdbExportTaskNames.RdbExportMonitorSaveProgress],
          {
            taskId: task.taskId,
            podId: task.payload.podId,
            cloudProvider: task.payload.cloudProvider,
            clusterId: task.payload.clusterId,
            region: task.payload.region,
            instanceId: task.payload.instanceId,
            hasTLS: task.payload.hasTLS,
          },
          {
            failParentOnFailure: true,
          },
          [
            this._makeJobNode(
              RdbExportTaskNames.RdbExportSendSaveCommand,
              ProcessorsSchemaMap[RdbExportTaskNames.RdbExportSendSaveCommand],
              {
                taskId: task.taskId,
                podId: task.payload.podId,
                cloudProvider: task.payload.cloudProvider,
                clusterId: task.payload.clusterId,
                region: task.payload.region,
                instanceId: task.payload.instanceId,
                hasTLS: task.payload.hasTLS,
              },
              {
                failParentOnFailure: true,
              }
            )
          ]
        )
      ]
    );

    if (this._isCustomerExportTarget(task)) {
      return copyRdbToBucketJob;
    }

    return this._makeJobNode(
      RdbExportTaskNames.RdbExportRequestReadSignedURL,
      ProcessorsSchemaMap[RdbExportTaskNames.RdbExportRequestReadSignedURL],
      {
        taskId: task.taskId,
        bucketName: task.payload.destination.bucketName,
        fileName: task.payload.destination.fileName,
        expiresIn: task.payload.destination.expiresIn,
      },
      {
        failParentOnFailure: true,
      },
      [copyRdbToBucketJob]
    )
  }

  _createMultiShardRDBExportFlow(
    task: ExportRDBTaskType,
  ): FlowJob {
    this._opts.logger.debug(`Creating multi shard RDB export flow for task: ${task.taskId}`);

    const _makePodJob = (node: { podId: string, partFileName: string }): FlowJob => {


      return this._makeJobNode(
        RdbExportTaskNames.RdbExportCopyRdbToBucket,
        ProcessorsSchemaMap[RdbExportTaskNames.RdbExportCopyRdbToBucket],
        {
          taskId: task.taskId,
          cloudProvider: task.payload.cloudProvider,
          clusterId: task.payload.clusterId,
          region: task.payload.region,
          instanceId: task.payload.instanceId,
          podId: node.podId,
          bucketName: task.payload.destination.bucketName,
          fileName: node.partFileName,
        },
        {
          failParentOnFailure: true,
        },
        [
          this._makeJobNode(
            RdbExportTaskNames.RdbExportMonitorSaveProgress,
            ProcessorsSchemaMap[RdbExportTaskNames.RdbExportMonitorSaveProgress],
            {
              taskId: task.taskId,
              podId: node.podId,
              cloudProvider: task.payload.cloudProvider,
              clusterId: task.payload.clusterId,
              region: task.payload.region,
              instanceId: task.payload.instanceId,
              hasTLS: task.payload.hasTLS,
            },
            {
              failParentOnFailure: true,
            },
            [
              this._makeJobNode(
                RdbExportTaskNames.RdbExportSendSaveCommand,
                ProcessorsSchemaMap[RdbExportTaskNames.RdbExportSendSaveCommand],
                {
                  taskId: task.taskId,
                  podId: node.podId,
                  cloudProvider: task.payload.cloudProvider,
                  clusterId: task.payload.clusterId,
                  region: task.payload.region,
                  instanceId: task.payload.instanceId,
                  hasTLS: task.payload.hasTLS,
                },
                {
                  failParentOnFailure: true,
                }
              )
            ]
          )
        ]
      )
    }

    const mergeJob = this._makeJobNode(
      RdbExportTaskNames.RdbExportMonitorRDBMerge,
      ProcessorsSchemaMap[RdbExportTaskNames.RdbExportMonitorRDBMerge],
      {
        taskId: task.taskId,
        cloudProvider: 'gcp',
        projectId: process.env.CTRL_PLANE_PROJECT_ID,
        clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
        region: process.env.CTRL_PLANE_REGION,
        namespace: process.env.NAMESPACE,
      },
      {
        failParentOnFailure: true
      },
      [
        this._makeJobNode(
          RdbExportTaskNames.RdbExportRequestRDBMerge,
          ProcessorsSchemaMap[RdbExportTaskNames.RdbExportRequestRDBMerge],
          {
            taskId: task.taskId,
            cloudProvider: 'gcp',
            projectId: process.env.CTRL_PLANE_PROJECT_ID,
            clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
            region: process.env.CTRL_PLANE_REGION,
            namespace: process.env.NAMESPACE,
            bucketName: task.payload.destination.bucketName,
            outputRdbFileName: task.payload.destination.fileName,
            rdbFileNames: (task.payload as MultiShardRDBExportPayloadType).destination.nodes.map(node => node.partFileName),
          },
          { failParentOnFailure: true },
          (task.payload as MultiShardRDBExportPayloadType).destination.nodes.map(node => _makePodJob(node)),
        )
      ]
    );

    if (this._isCustomerExportTarget(task)) {
      return this._makeJobNode(
        RdbExportTaskNames.RdbExportCopyRdbToBucket,
        ProcessorsSchemaMap[RdbExportTaskNames.RdbExportCopyRdbToBucket],
        {
          taskId: task.taskId,
          bucketName: task.payload.destination.bucketName,
          fileName: task.payload.destination.fileName,
        },
        {
          failParentOnFailure: true,
        },
        [mergeJob]
      );
    }

    return this._makeJobNode(
      RdbExportTaskNames.RdbExportRequestReadSignedURL,
      ProcessorsSchemaMap[RdbExportTaskNames.RdbExportRequestReadSignedURL],
      {
        taskId: task.taskId,
        bucketName: task.payload.destination.bucketName,
        fileName: task.payload.destination.fileName,
        expiresIn: task.payload.destination.expiresIn,
      },
      {
        failParentOnFailure: true,
      },
      [mergeJob]
    )
  }

  _createExportRDBFlow(
    task: ExportRDBTaskType,
  ): FlowJob {
    switch (task.type) {
      case 'SingleShardRDBExport':
        return this._createSingleShardRDBExportFlow(task);
      case 'MultiShardRDBExport':
        return this._createMultiShardRDBExportFlow(task);
      default:
        throw new Error('Unknown RDB export task type');
    }
  }

  _createImportRDBFlow(
    task: ImportRDBTaskType,
  ): FlowJob {
    this._opts.logger.debug(`Creating import RDB flow for task: ${task.taskId}`);
    const copySourceToBucketJob = task.payload.source
      ? this._makeJobNode(
        RdbImportTaskNames.RdbImportCopySourceToBucket,
        ProcessorsSchemaMap[RdbImportTaskNames.RdbImportCopySourceToBucket],
        {
          taskId: task.taskId,
          bucketName: task.payload.bucketName,
          fileName: task.payload.fileName,
        },
        {
          failParentOnFailure: true,
          jobId: `${task.taskId}-copy-source-to-bucket`,
        },
      )
      : undefined;

    const makeFormatValidationBranch = (children?: FlowChildJob[]): FlowJob => this._makeJobNode(
      RdbImportTaskNames.RdbImportMonitorFormatValidationProgress,
      ProcessorsSchemaMap[RdbImportTaskNames.RdbImportMonitorFormatValidationProgress],
      {
        taskId: task.taskId,
        cloudProvider: 'gcp',
        clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
        region: process.env.CTRL_PLANE_REGION,
        namespace: process.env.NAMESPACE,
        bucketName: task.payload.bucketName,
        jobResultFileName: task.payload.rdbKeyNumberFileName,
        projectId: process.env.CTRL_PLANE_PROJECT_ID,
      },
      {
        failParentOnFailure: true,
      },
      [
        this._makeJobNode(
          RdbImportTaskNames.RdbImportValidateRDBFormat,
          ProcessorsSchemaMap[RdbImportTaskNames.RdbImportValidateRDBFormat],
          {
            taskId: task.taskId,
            cloudProvider: 'gcp',
            clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
            region: process.env.CTRL_PLANE_REGION,
            namespace: process.env.NAMESPACE,
            bucketName: task.payload.bucketName,
            jobResultFileName: task.payload.rdbKeyNumberFileName,
            fileName: task.payload.fileName,
            projectId: process.env.CTRL_PLANE_PROJECT_ID,
          },
          {
            failParentOnFailure: true,
          },
          children,
        ),
      ],
    );

    const makeSizeValidationBranch = (children?: FlowChildJob[]): FlowJob => this._makeJobNode(
      RdbImportTaskNames.RdbImportMonitorSizeValidationProgress,
      ProcessorsSchemaMap[RdbImportTaskNames.RdbImportMonitorSizeValidationProgress],
      {
        taskId: task.taskId,
        cloudProvider: 'gcp',
        clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
        region: process.env.CTRL_PLANE_REGION,
        namespace: process.env.NAMESPACE,
        bucketName: task.payload.bucketName,
        jobResultFileName: task.payload.rdbSizeFileName,
        maxRdbSize: task.payload.deploymentSizeInMb,
        projectId: process.env.CTRL_PLANE_PROJECT_ID,
      },
      {
        failParentOnFailure: true,
      },
      [
        this._makeJobNode(
          RdbImportTaskNames.RdbImportValidateRDBSize,
          ProcessorsSchemaMap[RdbImportTaskNames.RdbImportValidateRDBSize],
          {
            taskId: task.taskId,
            cloudProvider: 'gcp',
            clusterId: process.env.CTRL_PLANE_CLUSTER_ID,
            region: process.env.CTRL_PLANE_REGION,
            namespace: process.env.NAMESPACE,
            bucketName: task.payload.bucketName,
            jobResultFileName: task.payload.rdbSizeFileName,
            fileName: task.payload.fileName,
            projectId: process.env.CTRL_PLANE_PROJECT_ID,
          },
          {
            failParentOnFailure: true,
          },
          children,
        ),
      ],
    );

    // BullMQ flows are trees, so one copy prerequisite cannot be shared by two sibling validation branches.
    // Keep customer-source validation serialized to avoid duplicate copy jobs and duplicate customer egress.
    const validationBranches = copySourceToBucketJob
      ? [makeSizeValidationBranch([makeFormatValidationBranch([copySourceToBucketJob])])]
      : [makeFormatValidationBranch(), makeSizeValidationBranch()];

    return this._makeJobNode(
      RdbImportTaskNames.RdbImportValidateImportKeyNumber,
      ProcessorsSchemaMap[RdbImportTaskNames.RdbImportValidateImportKeyNumber],
      {
        taskId: task.taskId,
        cloudProvider: task.payload.cloudProvider,
        clusterId: task.payload.clusterId,
        region: task.payload.region,
        instanceId: task.payload.instanceId,
        podIds: task.payload.podIds,
        hasTLS: task.payload.hasTLS,
        aofEnabled: task.payload.aofEnabled,
        backupPath: task.payload.backupPath,
        isCluster: task.payload.isCluster,
      },
      {
        failParentOnFailure: true,
      },
      [
        this._makeJobNode(
          RdbImportTaskNames.RdbImportMonitorImportRDB,
          ProcessorsSchemaMap[RdbImportTaskNames.RdbImportMonitorImportRDB],
          {
            taskId: task.taskId,
            cloudProvider: task.payload.cloudProvider,
            clusterId: task.payload.clusterId,
            region: task.payload.region,
            podIds: task.payload.podIds,
            aofEnabled: task.payload.aofEnabled,
            backupPath: task.payload.backupPath,
            namespace: task.payload.instanceId,
            projectId: process.env.APPLICATION_PLANE_PROJECT_ID,
          },
          {
            failParentOnFailure: true,
          },
          [
            this._makeJobNode(
              RdbImportTaskNames.RdbImportRequestRDBImport,
              ProcessorsSchemaMap[RdbImportTaskNames.RdbImportRequestRDBImport],
              {
                taskId: task.taskId,
                cloudProvider: task.payload.cloudProvider,
                clusterId: task.payload.clusterId,
                region: task.payload.region,
                projectId: process.env.APPLICATION_PLANE_PROJECT_ID,
                bucketName: task.payload.bucketName,
                fileName: task.payload.fileName,
                hasTLS: task.payload.hasTLS,
                instanceId: task.payload.instanceId,
                podId: task.payload.podIds[0],
              },
              {
                failParentOnFailure: true,
              },
              [
                this._makeJobNode(
                  RdbImportTaskNames.RdbImportFlushInstance,
                  ProcessorsSchemaMap[RdbImportTaskNames.RdbImportFlushInstance],
                  {
                    taskId: task.taskId,
                    cloudProvider: task.payload.cloudProvider,
                    clusterId: task.payload.clusterId,
                    region: task.payload.region,
                    instanceId: task.payload.instanceId,
                    podIds: task.payload.podIds,
                    hasTLS: task.payload.hasTLS,
                    isCluster: task.payload.isCluster,
                    aofEnabled: task.payload.aofEnabled,
                  },
                  {
                    failParentOnFailure: true,
                  },
                  [
                    this._makeJobNode(
                      RdbImportTaskNames.RdbImportMakeLocalBackup,
                      ProcessorsSchemaMap[RdbImportTaskNames.RdbImportMakeLocalBackup],
                      {
                        taskId: task.taskId,
                        cloudProvider: task.payload.cloudProvider,
                        clusterId: task.payload.clusterId,
                        region: task.payload.region,
                        instanceId: task.payload.instanceId,
                        podIds: task.payload.podIds,
                        aofEnabled: task.payload.aofEnabled,
                        backupPath: task.payload.backupPath,
                      },
                      {
                        failParentOnFailure: true,
                      },
                      [
                        this._makeJobNode(
                          RdbImportTaskNames.RdbImportMonitorSaveProgress,
                          ProcessorsSchemaMap[RdbImportTaskNames.RdbImportMonitorSaveProgress],
                          {
                            taskId: task.taskId,
                            cloudProvider: task.payload.cloudProvider,
                            clusterId: task.payload.clusterId,
                            region: task.payload.region,
                            instanceId: task.payload.instanceId,
                            podIds: task.payload.podIds,
                            aofEnabled: task.payload.aofEnabled,
                            hasTLS: task.payload.hasTLS,
                          },
                          {
                            failParentOnFailure: true,
                          },
                          [
                            this._makeJobNode(
                              RdbImportTaskNames.RdbImportSendSaveCommand,
                              ProcessorsSchemaMap[RdbImportTaskNames.RdbImportSendSaveCommand],
                              {
                                taskId: task.taskId,
                                cloudProvider: task.payload.cloudProvider,
                                clusterId: task.payload.clusterId,
                                region: task.payload.region,
                                instanceId: task.payload.instanceId,
                                podIds: task.payload.podIds,
                                hasTLS: task.payload.hasTLS,
                                aofEnabled: task.payload.aofEnabled,
                              },
                              {
                                failParentOnFailure: true,
                              },
                              validationBranches,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    )
  }

  async submitExportRDBTask(
    task: ExportRDBTaskType,
  ): Promise<void> {
    assert(process.env.CTRL_PLANE_PROJECT_ID, 'CTRL_PLANE_PROJECT_ID is not set');
    assert(process.env.CTRL_PLANE_CLUSTER_ID, 'CTRL_PLANE_CLUSTER_ID is not set');
    assert(process.env.CTRL_PLANE_REGION, 'CTRL_PLANE_REGION is not set');
    assert(process.env.NAMESPACE, 'NAMESPACE is not set');
    const flow = this._createExportRDBFlow(task)
    this._opts.logger.debug({ taskId: task.taskId, flow: sanitizeForLogging(flow) }, 'Submitting export RDB task to queue');
    await this._producer.add(
      flow,
    )
  }

  async submitImportRDBTask(
    task: ImportRDBTaskType
  ): Promise<void> {
    assert(process.env.APPLICATION_PLANE_PROJECT_ID, 'APPLICATION_PLANE_PROJECT_ID is not set');
    assert(process.env.CTRL_PLANE_PROJECT_ID, 'CTRL_PLANE_PROJECT_ID is not set');
    assert(process.env.CTRL_PLANE_CLUSTER_ID, 'CTRL_PLANE_CLUSTER_ID is not set');
    assert(process.env.CTRL_PLANE_REGION, 'CTRL_PLANE_REGION is not set');
    assert(process.env.NAMESPACE, 'NAMESPACE is not set');
    const flow = this._createImportRDBFlow(task)
    this._opts.logger.debug({ taskId: task.taskId, flow }, 'Submitting import RDB task to queue');
    await this._producer.add(
      flow,
    )
  }

}