import { K8sRepository } from '../repositories/k8s/K8sRepository';

const logger = {
  error: jest.fn(),
} as never;

describe('K8sRepository', () => {
  const repository = new K8sRepository({ logger });
  const hasRedisAuthError = (response: string) => (
    repository as unknown as { _hasRedisAuthError(response: string): boolean }
  )._hasRedisAuthError(response);

  it('does not treat Redis INFO error stats as an auth failure', () => {
    const info = [
      'redis_version:7.2.4',
      'errorstat_NOAUTH:count=3',
      'role:master',
    ].join('\n');

    expect(hasRedisAuthError(info)).toBe(false);
  });

  it('detects actual Redis auth error replies', () => {
    expect(hasRedisAuthError('NOAUTH Authentication required.')).toBe(true);
    expect(hasRedisAuthError('WRONGPASS invalid username-password pair or user is disabled.')).toBe(true);
  });
});