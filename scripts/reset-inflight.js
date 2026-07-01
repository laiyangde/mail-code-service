/**
 * 本地测试重置：清空在途租约与幂等记录、账号置 free、唯一码重置 unused。
 * **仅用于本地手动测试，勿用于生产**（会删除租约与收码记录）。
 * 运行：node scripts/reset-inflight.js
 */
import { openDb, DB_PATH } from '../src/store/db.js';

const db = openDb(DB_PATH);
db.prepare('DELETE FROM lease').run();
db.prepare('DELETE FROM processed_mail').run();
db.prepare("UPDATE email_account SET status='free', current_alias=NULL").run();
db.prepare("UPDATE access_code SET status='unused', bound_lease_id=NULL, retain_until=NULL").run();
console.log('已重置：在途租约清空、账号置 free、唯一码重置 unused');
process.exit(0);
