import { openWritableDatabase } from "../db/client";
import { generatePassword, hashPassword, isLockedPasswordHash, validatePassword } from "./password";

/**
 * 账号运维（只能在本机通过 CLI 使用）：列出账号、设置密码、批量初始化初始密码。
 *
 * 设计见 docs/harness/ACCOUNTS_AND_ORGS.md §5.4：
 * 网页端**不提供**任何重置他人密码的入口，忘记密码只能到这台机器上操作。
 */

export type AccountSummary = {
  username: string;
  email: string;
  name: string;
  role: string;
  orgName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /** false = 还是 locked$ 占位值，尚未设置过密码 */
  hasPassword: boolean;
};

const ACCOUNT_QUERY = `SELECT u.username AS username,
                              u.email AS email,
                              u.name AS name,
                              u.role AS role,
                              o.name AS orgName,
                              u.is_active AS isActive,
                              u.must_change_password AS mustChangePassword,
                              u.password_hash AS passwordHash
                         FROM users u
                    LEFT JOIN organizations o ON o.id = u.org_id`;

type AccountRow = {
  username: string;
  email: string;
  name: string;
  role: string;
  orgName: string | null;
  isActive: number;
  mustChangePassword: number;
  passwordHash: string;
};

function toSummary(row: AccountRow): AccountSummary {
  return {
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role,
    orgName: row.orgName,
    isActive: row.isActive === 1,
    mustChangePassword: row.mustChangePassword === 1,
    hasPassword: !isLockedPasswordHash(row.passwordHash),
  };
}

export function listAccounts(databasePath: string): AccountSummary[] {
  const database = openWritableDatabase(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const rows = database
      .prepare(`${ACCOUNT_QUERY} ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.username`)
      .all() as AccountRow[];
    return rows.map(toSummary);
  } finally {
    database.close();
  }
}

export class AccountNotFoundError extends Error {
  public constructor(username: string) {
    super(`账号不存在：${username}`);
    this.name = "AccountNotFoundError";
  }
}

/**
 * 给指定账号设置密码。`mustChangePassword` 默认 true（临时密码，首次登录需改），
 * 传 false 用于本人主动改密或管理员给自己设置长期密码。
 */
export async function setAccountPassword(options: {
  databasePath: string;
  username: string;
  password: string;
  mustChangePassword?: boolean;
}): Promise<void> {
  const invalid = validatePassword(options.password);
  if (invalid) throw new Error(invalid);
  const passwordHash = await hashPassword(options.password);

  const database = openWritableDatabase(options.databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const result = database
      .prepare("UPDATE users SET password_hash=?, must_change_password=?, updated_at=? WHERE username=?")
      .run(passwordHash, options.mustChangePassword === false ? 0 : 1, new Date().toISOString(), options.username) as {
      changes: number;
    };
    if (result.changes === 0) throw new AccountNotFoundError(options.username);
  } finally {
    database.close();
  }
}

export type IssuedPassword = { username: string; name: string; role: string; password: string };

/**
 * 一次性初始化：只处理 password_hash 仍是 locked$ 占位值的账号（幂等，重复执行不会覆盖已设密码）。
 */
export async function initMissingPasswords(
  databasePath: string,
  options: { mustChangePassword?: boolean } = {},
): Promise<IssuedPassword[]> {
  const database = openWritableDatabase(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const pending = database.prepare(`SELECT username, name, role, password_hash AS passwordHash FROM users`).all() as Array<{
      username: string;
      name: string;
      role: string;
      passwordHash: string;
    }>;
    const locked = pending.filter((row) => isLockedPasswordHash(row.passwordHash));
    const issued: IssuedPassword[] = [];
    for (const row of locked) {
      const password = generatePassword();
      const passwordHash = await hashPassword(password);
      database
        .prepare("UPDATE users SET password_hash=?, must_change_password=?, updated_at=? WHERE username=?")
        .run(passwordHash, options.mustChangePassword === false ? 0 : 1, new Date().toISOString(), row.username);
      issued.push({ username: row.username, name: row.name, role: row.role, password });
    }
    return issued;
  } finally {
    database.close();
  }
}
