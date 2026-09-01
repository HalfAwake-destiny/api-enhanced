const crypto = require('crypto')
const cloudbase = require('@cloudbase/node-sdk')

const COOKIE_ATTRIBUTES = new Set([
  'domain',
  'expires',
  'httponly',
  'max-age',
  'path',
  'samesite',
  'secure',
])

function parseCookieHeader(value = '') {
  const cookies = new Map()
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const cookieValue = part.slice(separator + 1).trim()
    if (!COOKIE_ATTRIBUTES.has(name.toLowerCase()))
      cookies.set(name, cookieValue)
  }
  return cookies
}

function mergeCookies(existing = '', setCookies = []) {
  const cookies = parseCookieHeader(existing)
  for (const setCookie of setCookies || []) {
    const firstPart = String(setCookie).split(';', 1)[0]
    const separator = firstPart.indexOf('=')
    if (separator < 1) continue
    const name = firstPart.slice(0, separator).trim()
    const value = firstPart.slice(separator + 1).trim()
    if (value) cookies.set(name, value)
    else cookies.delete(name)
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

function cookieExpiry(setCookies = [], fallback) {
  const musicCookie = (setCookies || []).find((item) =>
    /^MUSIC_[UA]=/i.test(String(item)),
  )
  if (!musicCookie) return fallback || null
  const maxAge = String(musicCookie).match(/Max-Age=(\d+)/i)
  if (maxAge) return new Date(Date.now() + Number(maxAge[1]) * 1000)
  const expires = String(musicCookie).match(/Expires=([^;]+)/i)
  if (!expires) return fallback || null
  const date = new Date(expires[1])
  return Number.isNaN(date.getTime()) ? fallback || null : date
}

function sameSecret(actual, expected) {
  const actualHash = crypto
    .createHash('sha256')
    .update(actual || '')
    .digest()
  const expectedHash = crypto
    .createHash('sha256')
    .update(expected || '')
    .digest()
  return crypto.timingSafeEqual(actualHash, expectedHash)
}

class SessionStore {
  constructor({
    envId,
    databaseInstance,
    databaseSchema,
    accessKey,
    encryptionKey,
  }) {
    this.key = crypto.createHash('sha256').update(encryptionKey).digest()
    this.db = cloudbase
      .init({
        env: envId,
        accessKey,
      })
      .rdb({
        instance: databaseInstance,
        database: databaseSchema,
      })
    this.table = 'halfawake_netease_session'
  }

  assertResult(result, operation) {
    if (result?.error) {
      const message = result.error.message || String(result.error)
      const error = new Error(`CloudBase ${operation} failed: ${message}`)
      error.code = result.error.code
      error.status = result.status
      throw error
    }
    return result?.data
  }

  normalize(row) {
    if (!row) return null
    return {
      ...row,
      cookie: this.decrypt(row.cookie_ciphertext),
    }
  }

  async get() {
    const result = await this.db
      .from(this.table)
      .select('*')
      .eq('id', 1)
      .limit(1)
    const rows = this.assertResult(result, 'select') || []
    return this.normalize(rows[0])
  }

  async save({ cookie, expiresAt, profile, status = 'active' }) {
    const previous = await this.get()
    const now = new Date().toISOString()
    const record = {
      id: 1,
      cookie_ciphertext: this.encrypt(cookie),
      expires_at: expiresAt
        ? new Date(expiresAt).toISOString()
        : previous?.expires_at || null,
      refreshed_at: now,
      checked_at: now,
      status,
      profile: profile || previous?.profile || null,
      updated_at: now,
    }
    const result = await this.db.from(this.table).upsert(record, {
      onConflict: 'id',
    })
    this.assertResult(result, 'upsert')
    return this.normalize(record)
  }

  encrypt(cookie) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([
      cipher.update(cookie, 'utf8'),
      cipher.final(),
    ])
    return [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString('base64url'))
      .join('.')
  }

  decrypt(value) {
    const [iv, tag, encrypted] = value
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'))
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8')
  }

  async updateStatus(status, profile) {
    const values = {
      status,
      checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (profile) values.profile = profile
    const result = await this.db.from(this.table).update(values).eq('id', 1)
    this.assertResult(result, 'update')
  }
}

module.exports = {
  SessionStore,
  cookieExpiry,
  mergeCookies,
  parseCookieHeader,
  sameSecret,
}
