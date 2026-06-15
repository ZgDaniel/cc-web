/**
 * 客户端 IP 解析（约 90 行）。
 *
 * 解决 X-Forwarded-For 伪造攻击：
 *   - 旧实现无脑信任 XFF 第一项，可被伪造绕过 IP 封禁 / 定向 DoS 受害者
 *   - 新实现：构造 XFF 链 + socket.remoteAddress，从右往左跳过可信代理，
 *     第一个非可信 IP = 真实客户端
 *
 * 配置：
 *   CC_WEB_TRUSTED_PROXIES="127.0.0.1,10.0.0.0/8,::1,2001:db8::/32"
 *
 * 重要：反向代理必须主动清洗客户端伪造的 XFF，否则即使 server 信任代理，
 *   代理若原样转发客户端 XFF，攻击者可向 XFF 链右侧注入伪造 IP。
 *   Nginx：proxy_set_header X-Forwarded-For $remote_addr;
 *
 * 工厂 createClientIpResolver(trustedProxyConfig) 返回：
 *   - isTrustedProxy(ip)
 *   - resolveClientIP(req)
 */
const net = require('net');

function familyOf(ip) {
  const t = net.isIP(ip);
  if (t === 4) return 'ipv4';
  if (t === 6) return 'ipv6';
  return null;
}

function normalizeIp(ip) {
  if (!ip) return null;
  const cleaned = String(ip).replace(/^::ffff:/, '');
  return net.isIP(cleaned) > 0 ? cleaned : null;
}

function createClientIpResolver(trustedProxyConfig) {
  const blocklist = new net.BlockList();
  const entries = String(trustedProxyConfig || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    let addr, bits, family;
    if (entry.includes('/')) {
      const parts = entry.split('/');
      addr = parts[0];
      bits = Number(parts[1]);
    } else {
      addr = entry;
      bits = null;
    }
    family = familyOf(addr.replace(/^::ffff:/, ''));
    if (!family) continue;
    try {
      if (bits !== null) {
        blocklist.addSubnet(addr, bits, family);
      } else {
        blocklist.addAddress(addr, family);
      }
    } catch {
      // ignore invalid entries (already logged upstream if needed)
    }
  }

  function isTrustedProxy(ip) {
    const cleaned = normalizeIp(ip);
    if (!cleaned) return false;
    const family = familyOf(cleaned);
    try {
      return blocklist.check(cleaned, family);
    } catch {
      return false;
    }
  }

  // 解析真实客户端 IP：构造 XFF 链 + socket.remoteAddress，
  // 从右往左跳过可信代理，返回第一个非可信 IP。
  // 严格模式：XFF 链中任何非法 token 都导致整个 XFF 被忽略，回退 socket.remoteAddress。
  function resolveClientIP(req) {
    const socketAddr = normalizeIp(req.socket?.remoteAddress);
    const forwarded = req.headers['x-forwarded-for'];
    let xffList = [];
    if (forwarded) {
      const raw = String(forwarded).split(',').map((s) => s.trim());
      // 出现任何非法 token → 整个 XFF 失效（防混淆攻击）
      const cleaned = [];
      let tainted = false;
      for (const item of raw) {
        const ip = normalizeIp(item);
        if (!ip) {
          tainted = true;
          break;
        }
        cleaned.push(ip);
      }
      if (!tainted) xffList = cleaned;
    }
    const chain = [...xffList];
    if (socketAddr) chain.push(socketAddr);
    if (chain.length === 0) return null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(chain[i])) {
        return chain[i];
      }
    }
    // 链全部可信（罕见），返回链首（最远的可能是真实客户端）
    return chain[0];
  }

  return { isTrustedProxy, resolveClientIP };
}

module.exports = { createClientIpResolver };
