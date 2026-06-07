import { FastifyBaseLogger } from 'fastify';
import { ILdapRepository, LdapUser, CreateUserRequest, ModifyUserRequest } from '../repositories/ldap/ILdapRepository';
import { validateAcl, isDefaultUserAclOutdated } from '../utils/acl-validator';
import { ApiError } from '@falkordb/errors';
import { ALLOWED_ACL } from '../constants';

export interface LdapServiceOptions {
  logger: FastifyBaseLogger;
  localPort: number;
  org: string;
  bearerToken: string;
  caCert: string;
}

export class LdapService {
  private _localPort: number;
  private _org: string;
  private _bearerToken: string;
  private _caCert: string;

  constructor(
    private _options: LdapServiceOptions,
    private _ldapRepository: ILdapRepository,
  ) {
    this._localPort = _options.localPort;
    this._org = _options.org;
    this._bearerToken = _options.bearerToken;
    this._caCert = _options.caCert;
  }

  async listUsers(): Promise<LdapUser[]> {
    const users = await this._ldapRepository.listUsers(
      this._localPort,
      this._org,
      this._bearerToken,
      this._caCert,
    );

    await this._syncDefaultUsersAcl(users);

    return users;
  }

  async createUser(user: CreateUserRequest): Promise<void> {
    // Validate ACL
    const validation = validateAcl(user.acl);
    if (!validation.valid) {
      throw ApiError.badRequest(
        `Invalid ACL: The following commands are not allowed: ${validation.invalidCommands.join(', ')}`,
        'INVALID_ACL',
      );
    }

    return this._ldapRepository.createUser(
      this._localPort,
      this._org,
      this._bearerToken,
      this._caCert,
      user,
    );
  }

  async modifyUser(username: string, user: ModifyUserRequest): Promise<void> {
    // Validate ACL if provided
    if (user.acl) {
      const validation = validateAcl(user.acl);
      if (!validation.valid) {
        throw ApiError.badRequest(
          `Invalid ACL: The following commands are not allowed: ${validation.invalidCommands.join(', ')}`,
          'INVALID_ACL',
        );
      }
    }

    return this._ldapRepository.modifyUser(
      this._localPort,
      this._org,
      this._bearerToken,
      this._caCert,
      username,
      user,
    );
  }

  async deleteUser(username: string): Promise<void> {
    return this._ldapRepository.deleteUser(
      this._localPort,
      this._org,
      this._bearerToken,
      this._caCert,
      username,
    );
  }

  /**
   * Sync the default user's ACL to the current ALLOWED_ACL.
   * The default user is identified by: first checking for username "falkordb",
   * then falling back to the oldest user by created_at.
   * Only updates if the user's ACL is outdated.
   */
  private async _syncDefaultUsersAcl(users: LdapUser[]): Promise<void> {
    const updatedAcl = `~* ${ALLOWED_ACL}`;

    const defaultUser = this._findDefaultUser(users);
    if (!defaultUser || !isDefaultUserAclOutdated(defaultUser.acl)) {
      return;
    }

    this._options.logger.info({ username: defaultUser.username }, 'Syncing default user ACL to current ALLOWED_ACL');

    try {
      await this._ldapRepository.modifyUser(
        this._localPort,
        this._org,
        this._bearerToken,
        this._caCert,
        defaultUser.username,
        { acl: updatedAcl },
      );
      defaultUser.acl = updatedAcl;
    } catch (error) {
      this._options.logger.error({ username: defaultUser.username, error }, 'Failed to sync default user ACL');
    }
  }

  private _findDefaultUser(users: LdapUser[]): LdapUser | undefined {
    // Prefer user with username "falkordb"
    const falkordbUser = users.find((user) => user.username === 'falkordb');
    if (falkordbUser) {
      return falkordbUser;
    }

    // Fall back to the oldest user by created_at
    if (users.length === 0) {
      return undefined;
    }

    const usersWithDate = users.filter((user) => user.createdAt);
    if (usersWithDate.length === 0) {
      return users[0];
    }

    return usersWithDate.reduce((oldest, user) =>
      new Date(user.createdAt) < new Date(oldest.createdAt) ? user : oldest,
    );
  }
}
