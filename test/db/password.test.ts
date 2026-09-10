import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCKED_PASSWORD_HASH,
  MIN_PASSWORD_LENGTH,
  generatePassword,
  hashPassword,
  isLockedPasswordHash,
  validatePassword,
  verifyPassword,
} from "../../server/src/security/password";

test("哈希格式带参数与盐，且同一密码两次哈希不同", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/u);
  assert.notEqual(first, second, "盐必须随机：同一密码两次哈希不能相同");
});

test("正确密码通过、错误密码失败", async () => {
  const stored = await hashPassword("s3cret-password");
  assert.equal(await verifyPassword("s3cret-password", stored), true);
  assert.equal(await verifyPassword("s3cret-passwor", stored), false);
  assert.equal(await verifyPassword("S3cret-password", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("locked 占位值对任何输入都判定失败", async () => {
  assert.equal(isLockedPasswordHash(LOCKED_PASSWORD_HASH), true);
  assert.equal(await verifyPassword("", LOCKED_PASSWORD_HASH), false);
  assert.equal(await verifyPassword("locked$", LOCKED_PASSWORD_HASH), false);
  assert.equal(await verifyPassword("anything at all", LOCKED_PASSWORD_HASH), false);
});

test("格式异常或参数异常的哈希一律判定失败且不抛异常", async () => {
  const cases = [
    "",
    "plaintext",
    "scrypt$16384$8$1$onlyfiveparts",
    "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
    "scrypt$notanumber$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==",
    // N 过小（低于下界）
    "scrypt$16$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==",
    // 参数大到足以拖死进程 → 必须被上界挡住
    "scrypt$1073741824$32$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==",
    // 盐/摘要太短
    "scrypt$16384$8$1$c2E=$aGFzaA==",
    "scrypt$16384$8$1$$",
  ];
  for (const stored of cases) {
    assert.equal(await verifyPassword("whatever", stored), false, `应拒绝：${stored}`);
    assert.equal(isLockedPasswordHash(stored), false);
  }
});

test("改过参数的哈希仍可校验（参数写在串里）", async () => {
  // N/r/p 与当前常量不同，但仍在允许区间内 → 应当能正常校验
  const { createHash, randomBytes, scrypt } = await import("node:crypto");
  void createHash;
  const salt = randomBytes(16);
  const n = 4096;
  const r = 8;
  const p = 2;
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt("legacy-password", salt, 64, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
  const stored = `scrypt$${n}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
  assert.equal(await verifyPassword("legacy-password", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("密码强度校验与随机密码生成", () => {
  assert.equal(validatePassword("1234567"), `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  assert.equal(validatePassword("12345678"), null);
  assert.equal(validatePassword("x".repeat(201)), "密码过长");
  assert.equal(validatePassword(undefined as unknown as string), `密码至少 ${MIN_PASSWORD_LENGTH} 位`);

  const generated = generatePassword();
  assert.equal(generated.length, 16);
  assert.equal(validatePassword(generated), null);
  assert.equal(/[^a-zA-Z0-9]/u.test(generated), false, "生成的密码只含字母数字");
  assert.notEqual(generatePassword(), generatePassword());
});
