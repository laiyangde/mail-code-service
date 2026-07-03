/**
 * Store 装配：把单个 db 连接组装为一组 repo，供 LeaseManager / Pool / Hub 等依赖注入。
 */
import { createAccountRepo } from './account.repo.js';
import { createPlanRepo } from './plan.repo.js';
import { createAccessCodeRepo } from './access-code.repo.js';
import { createLeaseRepo } from './lease.repo.js';
import { createProcessedMailRepo } from './processed-mail.repo.js';
import { createAuditLogRepo } from './audit-log.repo.js';
import { createAliasIndexRepo } from './alias-index.repo.js';

/**
 * @param {import('better-sqlite3').Database} db 已 applySchema 的连接
 * @returns {object} 含 db 与六个 repo 的 store
 */
export function createStore(db) {
  return {
    db,
    account: createAccountRepo(db),
    plan: createPlanRepo(db),
    accessCode: createAccessCodeRepo(db),
    lease: createLeaseRepo(db),
    processedMail: createProcessedMailRepo(db),
    auditLog: createAuditLogRepo(db),
    aliasIndex: createAliasIndexRepo(db),
  };
}
