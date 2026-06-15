/**
 * 鉴权存储（工厂模式，约 230 行）。
 *
 * 工厂 createAuthStore(deps) 注入路径常量、随机数源、当前时间，返回：
 *   hashPassword / verifyPassword / migrateFromPlaintext /
 *   issueToken / loadTokens / saveTokens / revokeAllTokens / isValidToken
 *
 * 安全设计要点（详见 docs/CONFIG.md "鉴权与安全"）：
 *   - 密码哈希：scrypt(N=16384, r=8, p=1, keylen=64) + 16 字节随机 salt
 *   - token 落盘只存 sha256 指纹（digest），不存原始 token
 *   - 所有比较用 timingSafeEqual 防时序侧信道
 *   - tokens.json / auth.json 原子写（tmp + fsync + rename, 0600）
 *   - revokeAllTokens 原子封装：先写 tokens.json（旧 token 立即失效）→ 再写 auth.json（新密码生效）
 *     任意点崩溃都不会出现"密码已改但旧 token 仍可用"
 *
 * schema：
 *   auth.json  = { alg:'scrypt', salt, hash, params:{N,r,p,keylen}, mustChange, version:2 }
 *   tokens.json = { tokens:[{ digest, issuedAt, expiresAt, absoluteExpiresAt }] }
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
const SALT_LEN = 16;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_MAXMEM_FALLBACK = 128 * 1024 * 1024;

function createAuthStore(deps) {
  const {
    AUTH_CONFIG_PATH,
    TOKENS_PATH,
    now = () => Date.now(),
    randomBytes = (n) => crypto.randomBytes(n),
  } = deps;

  // --- 原子写（tmp + fsync + rename, 0600） ---
  function atomicWrite(filePath, data) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try {
      const fd = fs.openSync(tmp, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch {
      // fsync 不可用时（罕见文件系统）容忍，rename 仍是原子的
    }
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  // --- scrypt 包装：maxmem 超限时自动提升，避免 EINVAL ---
  function scryptHash(plain, salt) {
    const paramCandidates = [
      { ...SCRYPT_PARAMS, maxmem: SCRYPT_PARAMS.maxmem },
      { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM_FALLBACK },
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
    ];
    let lastErr;
    for (const params of paramCandidates) {
      try {
        return crypto.scryptSync(Buffer.from(plain, 'utf8'), salt, KEY_LEN, params);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  function hashPassword(plain) {
    const salt = randomBytes(SALT_LEN);
    const hash = scryptHash(plain, salt);
    return {
      alg: 'scrypt',
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: KEY_LEN },
      version: 2,
    };
  }

  function verifyPassword(plain, stored) {
    if (!stored || stored.alg !== 'scrypt' || !stored.salt || !stored.hash) return false;
    let salt, expected;
    try {
      salt = Buffer.from(stored.salt, 'hex');
      expected = Buffer.from(stored.hash, 'hex');
    } catch {
      return false;
    }
    if (expected.length === 0) return false;
    let actual;
    try {
      actual = scryptHash(plain, salt);
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  // 检测旧 schema（含明文 password 字段）并派生新哈希。非旧 schema 原样返回。
  function migrateFromPlaintext(oldConfig) {
    if (!oldConfig || typeof oldConfig !== 'object') return null;
    if (oldConfig.alg === 'scrypt' && oldConfig.hash) return oldConfig;
    if (typeof oldConfig.password === 'string' && oldConfig.password.length > 0) {
      const derived = hashPassword(oldConfig.password);
      return {
        ...derived,
        mustChange: !!oldConfig.mustChange,
        version: 2,
      };
    }
    return null;
  }

  // --- token：32 字节 base64url，落盘只存 sha256 指纹 ---
  function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  function issueToken() {
    const rawBytes = randomBytes(32);
    const token = rawBytes.toString('base64url');
    const nowMs = now();
    return {
      token,
      digest: sha256Hex(token),
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
      absoluteExpiresAt: new Date(nowMs + TOKEN_ABSOLUTE_TTL_MS).toISOString(),
    };
  }

  // 从磁盘加载 + 清理过期，返回 { map, dirty }（map: digest → record）
  function loadTokens() {
    const map = new Map();
    if (!fs.existsSync(TOKENS_PATH)) return { map, dirty: false };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch {
      return { map, dirty: false };
    }
    const arr = Array.isArray(parsed && parsed.tokens) ? parsed.tokens : [];
    const cutoff = now();
    let dirty = false;
    for (const rec of arr) {
      if (!rec || typeof rec.digest !== 'string' || rec.digest.length === 0) continue;
      const exp = Date.parse(rec.expiresAt || '');
      if (!Number.isFinite(exp) || exp < cutoff) {
        dirty = true;
        continue;
      }
      // absoluteExpiresAt 缺失（老 schema）：基于 issuedAt 补字段
      // - issuedAt 缺失或推断出的绝对过期已过 → 丢弃（无法判定绝对上限）
      // - 否则补 absoluteExpiresAt 字段并标记 dirty（写回修正后的记录）
      let absExp = Date.parse(rec.absoluteExpiresAt || '');
      if (!Number.isFinite(absExp)) {
        const issued = Date.parse(rec.issuedAt || '');
        if (!Number.isFinite(issued)) {
          dirty = true;
          continue;
        }
        const computed = issued + TOKEN_ABSOLUTE_TTL_MS;
        if (computed < cutoff) {
          dirty = true;
          continue;
        }
        rec.absoluteExpiresAt = new Date(computed).toISOString();
        dirty = true;
        absExp = computed;
      }
      if (absExp < cutoff) {
        dirty = true;
        continue;
      }
      map.set(rec.digest, rec);
    }
    return { map, dirty };
  }

  // 原子写 tokens.json。入参支持 Map 或 record 数组。
  // 安全：只落盘 digest + issuedAt + expiresAt，绝不写原始 token。
  function saveTokens(mapOrRecords) {
    const rawRecords = mapOrRecords instanceof Map
      ? Array.from(mapOrRecords.values())
      : Array.isArray(mapOrRecords) ? mapOrRecords : [];
    const records = rawRecords.map((r) => {
      const rec = r && r.record ? r.record : r;
      return {
        digest: rec.digest,
        issuedAt: rec.issuedAt,
        expiresAt: rec.expiresAt,
        absoluteExpiresAt: rec.absoluteExpiresAt,
      };
    });
    atomicWrite(TOKENS_PATH, JSON.stringify({ tokens: records }, null, 2));
  }

  // 原子封装：清空所有 token + 写新密码 hash + 可选签发当前连接新 token。
  // 顺序严格：先写 tokens.json（旧 token 立即失效）→ 再写 auth.json（新密码生效）。
  // 任意点崩溃都不会出现"密码已改但旧 token 仍可用"。
  // issueNewForConnection=true 时签发新 token 并跟随 tokens.json 落盘，返回 { tokenMap, newToken }。
  function revokeAllTokens({ newHashConfig, issueNewForConnection = false } = {}) {
    const fresh = new Map();
    let newToken = null;
    if (issueNewForConnection) {
      newToken = issueToken();
      fresh.set(newToken.digest, newToken);
    }
    saveTokens(fresh);
    if (newHashConfig) {
      atomicWrite(AUTH_CONFIG_PATH, JSON.stringify(newHashConfig, null, 2));
    }
    return { tokenMap: fresh, newToken };
  }

  // isValidToken：内存命中优先，否则算 digest 比对磁盘。
  // 由调用方维护内存 Map（lastActive），这里只负责摘要比对。
  function digestOf(token) {
    return sha256Hex(token);
  }

  return {
    hashPassword,
    verifyPassword,
    migrateFromPlaintext,
    issueToken,
    loadTokens,
    saveTokens,
    revokeAllTokens,
    digestOf,
    TOKEN_TTL_MS,
    TOKEN_ABSOLUTE_TTL_MS,
  };
}

module.exports = { createAuthStore };
