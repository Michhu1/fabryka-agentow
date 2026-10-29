import type { AppConfig } from '@app/config';
import { DataSource } from 'typeorm';
import { ApiKey } from './entities/api-key.entity.js';
import { InvalidAuthToken } from './entities/invalid-auth-token.entity.js';
import { Project } from './entities/project.entity.js';
import { ProjectInvitation } from './entities/project-invitation.entity.js';
import { ProjectRelation } from './entities/project-relation.entity.js';
import { ProjectTransfer } from './entities/project-transfer.entity.js';
import { Setting } from './entities/setting.entity.js';
import { User } from './entities/user.entity.js';
import { Init1761523200000 } from './migrations/0001-init.js';
import { Accounts1761696000000 } from './migrations/0002-accounts.js';
import { ProjectOwnership1761782400000 } from './migrations/0003-project-ownership.js';
import { ProjectInvitationsAndTransfers1761868800000 } from './migrations/0004-project-invitations-and-transfers.js';
import { SafeTypeormLogger } from './safe-logger.js';

export function createDataSource(config: AppConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: true, ca: config.db.sslCa } : false,
    entities: [
      Setting,
      User,
      Project,
      ProjectRelation,
      InvalidAuthToken,
      ApiKey,
      ProjectInvitation,
      ProjectTransfer,
    ],
    migrations: [
      Init1761523200000,
      Accounts1761696000000,
      ProjectOwnership1761782400000,
      ProjectInvitationsAndTransfers1761868800000,
    ],
    migrationsRun: false,
    synchronize: false,
    logging: ['error'],
    logger: new SafeTypeormLogger(),
  });
}
