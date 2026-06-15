import { ICaptchaRepository } from './ICaptchaRepository';

export class CaptchaRepositoryMock implements ICaptchaRepository {
  static repositoryName = 'ICaptchaRepository';

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
