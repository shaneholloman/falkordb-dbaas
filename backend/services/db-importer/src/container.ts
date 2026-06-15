import { diContainer } from '@fastify/awilix';
import { asFunction } from 'awilix';
import { FastifyInstance } from 'fastify';
import { ICaptchaRepository } from './repositories/captcha/ICaptchaRepository';
import { ReCaptchaRepository } from './repositories/captcha/ReCaptchaRepository';
import { ITasksDBRepository, TasksDBMongoRepository } from './repositories/tasks';
import { OmnistrateRepository } from './repositories/omnistrate/OmnistrateRepository';
import { K8sRepository } from './repositories/k8s/K8sRepository';
import { CaptchaRepositoryMock } from './repositories/captcha/CaptchaRepositoryMock';
import { ITaskQueueRepository } from './repositories/tasksQueue/ITaskQueueRepository';
import { TaskQueueBullMQRepository } from './repositories/tasksQueue/TaskQueueBullMQRepository';
import { IBlobStorageRepository } from './repositories/blob/IBlobStorageRepository';
import { BlobStorageGCSRepository } from './repositories/blob/BlobStorageGCSRepository';
import { ISchedulesDBRepository, SchedulesDBMongoRepository } from './repositories/schedules';

export const setupGlobalContainer = (fastify: FastifyInstance) => {
  diContainer.register({
    [ICaptchaRepository.repositoryName]: asFunction(() => {
      if (process.env.NODE_ENV !== 'production' && process.env.MOCK_CAPTCHA_REPOSITORY === 'true') {
        return new CaptchaRepositoryMock();
      }

      return new ReCaptchaRepository(fastify.config.GOOGLE_RECAPTCHA_SECRET_KEY, {
        logger: fastify.log,
      });
    }).singleton(),

    [ITasksDBRepository.name]: asFunction(() => {
      return new TasksDBMongoRepository({
        logger: fastify.log,
      });
    }).singleton(),

    [ISchedulesDBRepository.name]: asFunction(() => {
      return new SchedulesDBMongoRepository({
        logger: fastify.log,
      });
    }).singleton(),

    [OmnistrateRepository.name]: asFunction(() => {
      return new OmnistrateRepository(
        fastify.config.OMNISTRATE_EMAIL,
        fastify.config.OMNISTRATE_PASSWORD,
        fastify.config.OMNISTRATE_SERVICE_ID,
        fastify.config.OMNISTRATE_ENVIRONMENT_ID,
        {
          logger: fastify.log,
        },
      );
    }).singleton(),

    [K8sRepository.name]: asFunction(() => {
      return new K8sRepository({
        logger: fastify.log,
      });
    }).singleton(),

    [ITaskQueueRepository.name]: asFunction(() => {
      return new TaskQueueBullMQRepository({
        logger: fastify.log,
      });
    }).singleton(),

    [IBlobStorageRepository.name]: asFunction(() => {
      return new BlobStorageGCSRepository({
        logger: fastify.log,
      });
    }).singleton(),
  });
};

export const setupContainer = () => {
  diContainer.register({});
};
