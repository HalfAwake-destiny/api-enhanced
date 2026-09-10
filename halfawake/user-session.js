const crypto = require('crypto')

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

// 把「网易云 cookie + 过期时间 + 昵称头像」封成一个只有服务端能解开的 token。
// 这样每个用户的登录态不需要新建表、不需要迁移：客户端自己存 token，服务端每次解开用。
// 加密方式和 SessionStore 一致（AES-256-GCM），密钥同样来自 NETEASE_SESSION_KEY。
function createUserSession(encryptionKey, ttlMs = DEFAULT_TTL_MS) {
  const key = crypto.createHash('sha256').update(encryptionKey || '').digest()
  const enabled = Boolean(encryptionKey)

  function seal(payload) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ])
    return [iv, cipher.getAuthTag(), body]
      .map((part) => part.toString('base64url'))
      .join('.')
  }

  function open(token) {
    if (!enabled || typeof token !== 'string' || !token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    try {
      const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url'))
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const payload = JSON.parse(
        Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'),
      )
      if (!payload || !payload.cookie) return null
      if (payload.exp && Date.now() > payload.exp) return null
      return payload
    } catch (_) {
      return null
    }
  }

  return { seal, open, enabled, ttl: ttlMs }
}

module.exports = { createUserSession, DEFAULT_TTL_MS }
