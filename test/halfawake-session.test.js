const assert = require('assert')
const {
  SessionStore,
  cookieExpiry,
  mergeCookies,
  parseCookieHeader,
  sameSecret,
} = require('../halfawake/session-store')
const { createUserSession } = require('../halfawake/user-session')

describe('Half Awake music session', () => {
  it('merges rotated cookies without retaining Set-Cookie attributes', () => {
    const merged = mergeCookies('MUSIC_U=old; __csrf=one', [
      'MUSIC_U=new; Max-Age=1296000; Path=/; HttpOnly',
      '__csrf=two; Path=/',
    ])
    assert.deepStrictEqual(Object.fromEntries(parseCookieHeader(merged)), {
      MUSIC_U: 'new',
      __csrf: 'two',
    })
  })

  it('encrypts and decrypts a cookie with authenticated encryption', () => {
    const store = Object.create(SessionStore.prototype)
    store.key = require('crypto')
      .createHash('sha256')
      .update('test-key')
      .digest()
    const encrypted = store.encrypt('MUSIC_U=secret')
    assert.notStrictEqual(encrypted, 'MUSIC_U=secret')
    assert.strictEqual(store.decrypt(encrypted), 'MUSIC_U=secret')
  })

  it('reads Max-Age from the account cookie', () => {
    const before = Date.now() + 1296000 * 1000
    const expiry = cookieExpiry(['MUSIC_U=x; Max-Age=1296000; Path=/'])
    assert(Math.abs(expiry.getTime() - before) < 1000)
  })

  it('compares admin tokens without comparing their raw values', () => {
    assert.strictEqual(sameSecret('correct', 'correct'), true)
    assert.strictEqual(sameSecret('wrong', 'correct'), false)
  })
})

describe('Half Awake user session token', () => {
  const key = 'a'.repeat(48)

  it('seals and opens a per-user cookie without exposing it', () => {
    const session = createUserSession(key)
    const token = session.seal({
      cookie: 'MUSIC_U=user-secret',
      exp: Date.now() + 1000,
      profile: { nickname: '小明', userId: 42 },
    })
    assert(token.indexOf('user-secret') === -1, 'token 里不应出现明文 cookie')
    const payload = session.open(token)
    assert.strictEqual(payload.cookie, 'MUSIC_U=user-secret')
    assert.strictEqual(payload.profile.nickname, '小明')
  })

  it('rejects tampered, expired and foreign-key tokens', () => {
    const session = createUserSession(key)
    const token = session.seal({ cookie: 'MUSIC_U=x', exp: Date.now() + 1000 })
    assert.strictEqual(session.open(token.slice(0, -2) + 'aa'), null)
    assert.strictEqual(session.open('not-a-token'), null)
    assert.strictEqual(session.open(''), null)
    assert.strictEqual(session.open(null), null)
    // 另一把密钥解不开（防止不同环境互相通用）
    assert.strictEqual(createUserSession('b'.repeat(48)).open(token), null)
    // 过期就作废
    const expired = session.seal({ cookie: 'MUSIC_U=x', exp: Date.now() - 1 })
    assert.strictEqual(session.open(expired), null)
  })

  it('stays disabled when no key is configured', () => {
    const session = createUserSession('')
    assert.strictEqual(session.enabled, false)
    assert.strictEqual(session.open(session.seal({ cookie: 'x' })), null)
  })
})
