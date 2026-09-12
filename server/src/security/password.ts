import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 密码哈希：Node 内置 scrypt，不引第三方依赖。
 *
 * 存储格式（参数写进串里，将来调参不影响老密码）：
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *
 * 特殊前缀 `locked$` 表示"该账号还没有设置密码"（迁移时的占位值），
 * 任何输入都必须校验失败 —— 见 docs/harness/ACCOUNTS_AND_ORGS.md §3.2。
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

/** 未设置密码的占位值：登录时永远不匹配 */
export const LOCKED_PASSWORD_HASH = "locked$";

/** 密码最小长度（本机自用，不强制大小写/符号组合） */
export const MIN_PASSWORD_LENGTH = 8;

export function isLockedPasswordHash(stored: string): boolean {
  return stored.startsWith("locked$");
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** 存储串的组装（同步/异步两条路径共用，免得格式漂移） */
function formatHash(salt: Buffer, key: Buffer): string {
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return formatHash(salt, key);
}

/**
 * 同步版本。只有一处用途：**数据库自举时用 `WORKBENCH_ADMIN_PASSWORD` 给 `admin` 设初始密码**。
 *
 * 为什么必须是同步的：自举跑在同步的 `node:sqlite` API 里（`appDatabase()` 也是同步函数，
 * 调用点遍布请求路径），为它把整条启动链改成 async 不划算。默认参数下一次约 50-100ms，
 * 而且只在「首次建库」或「管理员还没有密码」时各发生一次。
 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM });
  return formatHash(salt, key);
}

/**
 * 校验密码。任何格式异常、参数异常、locked 占位值都返回 false，
 * 不抛异常 —— 登录路径不应该因为一条坏记录而 500。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!password || isLockedPasswordHash(stored)) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 参数来自库里，必须做上界校验：否则一条被改坏的记录能拖死进程（scrypt 参数越大越慢）
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if (128 * n * r > MAX_MEM) return false;

  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length < 8 || expected.length < 16) return false;

  const actual = await derive(password, salt, n, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 密码强度校验；返回错误信息或 null（合法） */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (password.length > 200) return "密码过长";
  return null;
}

/** 生成一个初始密码（人类可读、去掉了易混字符） */
export function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let output = "";
  for (const byte of bytes) output += alphabet[byte % alphabet.length];
  return output;
}
