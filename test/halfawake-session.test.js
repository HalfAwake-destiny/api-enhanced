const assert = require('assert')
const {
  SessionStore,
  cookieExpiry,
  mergeCookies,
  parseCookieHeader,
  sameSecret,
} = require('../halfawake/session-store')

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
