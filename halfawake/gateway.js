const express = require('express')
const axios = require('axios')
const path = require('path')
const request = require('../util/request')
const captchaSent = require('../module/captcha_sent')
const cloudsearch = require('../module/cloudsearch')
const loginCellphone = require('../module/login_cellphone')
const logoutModule = require('../module/logout')
const lyric = require('../module/lyric')
const loginQrCheck = require('../module/login_qr_check')
const loginQrCreate = require('../module/login_qr_create')
const loginQrKey = require('../module/login_qr_key')
const loginRefresh = require('../module/login_refresh')
const loginStatus = require('../module/login_status')
const playlistTrackAll = require('../module/playlist_track_all')
const songUrlV1 = require('../module/song_url_v1')
const userPlaylist = require('../module/user_playlist')
const {
  SessionStore,
  cookieExpiry,
  mergeCookies,
  sameSecret,
} = require('./session-store')
const { createUserSession } = require('./user-session')

const DAY = 24 * 60 * 60 * 1000
const AUDIO_LEVELS = ['standard', 'higher', 'exhigh', 'lossless']
// 透传给小程序的音频响应头，少了 Range/Content-Range 拖进度条会失效
const AUDIO_PASSTHROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
]

// 验证码频率限制（进程内存即可，容器重启后清零，够挡住随手刷）
const CAPTCHA_HITS = new Map()
const CAPTCHA_WINDOW = 60 * 60 * 1000
const CAPTCHA_GAP = 60 * 1000
const CAPTCHA_MAX = 5

function takeCaptchaSlot(key) {
  const now = Date.now()
  const hits = (CAPTCHA_HITS.get(key) || []).filter(
    (time) => now - time < CAPTCHA_WINDOW,
  )
  if (hits.length >= CAPTCHA_MAX) return '这个手机号今天验证码要得太多了，过一会儿再试'
  if (hits.length && now - hits[hits.length - 1] < CAPTCHA_GAP)
    return '刚发过验证码，等一分钟再试'
  hits.push(now)
  CAPTCHA_HITS.set(key, hits)
  return ''
}

// 网易风控要求人机验证时会返回 -462，带上它自己的验证页地址。
// 小程序里没法渲染那个验证页，所以把话说明白，让前端能提示用户改用公共曲库。
function loginFailureBody(error) {
  const body = (error && error.body) || {}
  const code = body.code || 502
  if (code === -462 || code === 8821) {
    return {
      code,
      message: '网易要求人机验证，这次登不进去；可以先去公共曲库听歌，稍后再试',
    }
  }
  return {
    code,
    message: body.message || body.msg || '登录请求失败，稍后再试',
  }
}

function bearerToken(req) {
  const header = req.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

// 用户 token 还额外认 ?token= —— 音频要交给 wx.createInnerAudioContext 播，它带不了请求头。
// 管理员的 token 只用请求头（bearerToken），不走这里，免得密钥出现在 URL 里。
function userToken(req) {
  const fromHeader = bearerToken(req)
  if (fromHeader) return fromHeader
  return String((req.query && req.query.token) || '')
}

function numberParam(value, { fallback, min, max }) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function publicBody(result) {
  if (!result || typeof result.body !== 'object') return result?.body || {}
  const { cookie: _cookie, ...body } = result.body
  return body
}

function databaseDiagnostic(error) {
  const message = String(error?.message || error || 'Unknown database error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/MUSIC_[UA]=[^;\s]+/gi, 'MUSIC_U=[redacted]')
    .slice(0, 300)
  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    status: error?.status || null,
    message,
  }
}

function createHalfawakeGateway() {
  const router = express.Router()
  const envId = process.env.HALFAWAKE_CLOUDBASE_ENV_ID
  const databaseInstance = process.env.HALFAWAKE_CLOUDBASE_DATABASE
  const databaseSchema = process.env.HALFAWAKE_CLOUDBASE_SCHEMA || 'public'
  const cloudbaseApiKey = process.env.CLOUDBASE_APIKEY
  const encryptionKey = process.env.NETEASE_SESSION_KEY
  const adminToken = process.env.MUSIC_ADMIN_TOKEN
  const configured = Boolean(
    envId && databaseInstance && cloudbaseApiKey && encryptionKey && adminToken,
  )
  // 用户登录态：cookie 密封在 token 里由客户端自己存，不需要建表迁移
  const userSession = createUserSession(encryptionKey)
  let store = null
  if (configured) {
    store = new SessionStore({
      envId,
      databaseInstance,
      databaseSchema,
      accessKey: cloudbaseApiKey,
      encryptionKey,
    })
  }
  let refreshPromise = null

  router.use((_, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  function requireConfigured(_, res, next) {
    if (!configured) {
      res
        .status(503)
        .json({ code: 503, message: 'Music session is not configured.' })
      return
    }
    next()
  }

  function requireAdmin(req, res, next) {
    if (!sameSecret(bearerToken(req), adminToken)) {
      res.status(401).json({ code: 401, message: 'Unauthorized' })
      return
    }
    next()
  }

  async function call(module, query) {
    return module(query, request)
  }

  async function inspect(cookie) {
    const result = await call(loginStatus, { cookie, noCookie: true })
    const account = result?.body?.data?.account
    const profile = result?.body?.data?.profile
    let publicProfile = null
    if (profile) {
      publicProfile = {
        nickname: profile.nickname,
        userId: profile.userId,
        avatarUrl: profile.avatarUrl,
      }
    }
    return {
      active: result?.body?.data?.code === 200 && Boolean(account),
      profile: publicProfile,
    }
  }

  async function refreshSession(force = false) {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      const session = await store.get()
      if (!session) return null
      const refreshedAt = session.refreshed_at
        ? new Date(session.refreshed_at).getTime()
        : 0
      if (!force && Date.now() - refreshedAt < 7 * DAY) return session
      try {
        const result = await call(loginRefresh, {
          cookie: session.cookie,
          noCookie: true,
        })
        const cookie = mergeCookies(session.cookie, result.cookie)
        const account = await inspect(cookie)
        if (!account.active) {
          await store.updateStatus('login_required')
          return session
        }
        return store.save({
          cookie,
          expiresAt: cookieExpiry(result.cookie, session.expires_at),
          profile: account.profile,
        })
      } catch (_) {
        await store.updateStatus('refresh_failed')
        return session
      }
    })().finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  async function sessionCookie() {
    const session = await refreshSession(false)
    return session?.cookie || ''
  }

  function handle(module, queryFactory, { login = false } = {}) {
    return async (req, res) => {
      try {
        const query = queryFactory(req)
        if (login) {
          const cookie = await sessionCookie()
          if (!cookie) {
            res
              .status(401)
              .json({ code: 301, message: 'Music login required.' })
            return
          }
          query.cookie = cookie
        }
        query.noCookie = true
        const result = await call(module, query)
        res.status(result.status || 200).json(publicBody(result))
      } catch (_) {
        res.status(502).json({ code: 502, message: 'NetEase request failed.' })
      }
    }
  }

  router.get('/halfawake-admin', (_, res) => {
    res.type('html').sendFile(path.join(__dirname, 'admin.html'))
  })

  router.use('/halfawake/admin', requireConfigured, requireAdmin)

  router.post('/halfawake/admin/qr/start', async (_, res) => {
    try {
      const keyResult = await call(loginQrKey, { noCookie: true })
      const key =
        keyResult?.body?.data?.unikey || keyResult?.body?.data?.data?.unikey
      if (!key) throw new Error('Missing QR key')
      const qrResult = await loginQrCreate({ key, qrimg: true, platform: 'pc' })
      res.json({
        code: 200,
        key,
        qrimg: qrResult?.body?.data?.qrimg,
      })
    } catch (_) {
      res.status(502).json({ code: 502, message: 'Unable to create QR code.' })
    }
  })

  router.post('/halfawake/admin/qr/check', async (req, res) => {
    const key = String(req.body?.key || '')
    if (!key) {
      res.status(400).json({ code: 400, message: 'Missing QR key.' })
      return
    }
    try {
      const result = await call(loginQrCheck, { key, noCookie: true })
      const code = result?.body?.code
      if (code === 803 && result.cookie?.length) {
        const cookie = mergeCookies('', result.cookie)
        const account = await inspect(cookie)
        if (!account.active) throw new Error('Login verification failed')
        await store.save({
          cookie,
          expiresAt: cookieExpiry(result.cookie),
          profile: account.profile,
        })
      }
      res.json({ code, message: result?.body?.message || '' })
    } catch (_) {
      res.status(502).json({ code: 502, message: 'Unable to verify QR login.' })
    }
  })

  router.get('/halfawake/admin/status', async (_, res) => {
    try {
      const session = await store.get()
      if (!session) {
        res.json({ configured: true, loggedIn: false, status: 'empty' })
        return
      }
      res.json({
        configured: true,
        loggedIn: session.status === 'active',
        status: session.status,
        profile: session.profile,
        expiresAt: session.expires_at,
        refreshedAt: session.refreshed_at,
        checkedAt: session.checked_at,
      })
    } catch (error) {
      res.status(503).json({
        code: 503,
        message: 'Database unavailable.',
        diagnostic: databaseDiagnostic(error),
      })
    }
  })

  router.post('/halfawake/admin/refresh', async (_, res) => {
    const session = await refreshSession(true)
    res.json({
      code: session?.status === 'active' ? 200 : 301,
      status: session?.status || 'empty',
    })
  })

  router.post('/halfawake/admin/maintain', async (_, res) => {
    const session = await refreshSession(false)
    res.json({
      code: session?.status === 'active' ? 200 : 301,
      status: session?.status || 'empty',
      refreshedAt: session?.refreshed_at || null,
    })
  })

  // ---------- 用户登录：让每个用户登录自己的网易云账号 ----------
  // 登录态不落库：cookie 用 AES-256-GCM 封成 token 交给客户端自己存，服务端每次解开用。

  function requireUser(req, res) {
    if (!userSession.enabled) {
      res
        .status(503)
        .json({ code: 503, message: '服务端没配 NETEASE_SESSION_KEY，无法保管登录态' })
      return null
    }
    const payload = userSession.open(userToken(req))
    if (!payload) {
      res.status(401).json({ code: 301, message: '网易云登录已失效，请重新登录' })
      return null
    }
    return payload
  }

  // 网易 cookie 会过期，顺手用 login_refresh 续一次；续上了把新 token 一起回给客户端
  async function refreshUserPayload(payload) {
    let account = { active: false, profile: null }
    try {
      const result = await call(loginRefresh, {
        cookie: payload.cookie,
        noCookie: true,
      })
      const cookie = mergeCookies(payload.cookie, result.cookie)
      account = await inspect(cookie)
      if (!account.active) return { payload, active: false, token: null }
      const next = {
        cookie,
        exp: Date.now() + userSession.ttl,
        profile: account.profile || payload.profile || null,
        uid: (account.profile && account.profile.userId) || payload.uid || null,
      }
      return { payload: next, active: true, token: userSession.seal(next) }
    } catch (_) {
      account = await inspect(payload.cookie).catch(() => ({ active: false }))
      return { payload, active: account.active, token: null }
    }
  }

  // 音频代理：网易给的地址是 http:// 且是 m*.music.126.net，小程序真机播不了，
  // 必须由我们转成自己域名的 https，并把 Range 等头原样透传（否则拖进度条失效）。
  async function proxyAudio(req, res, payload) {
    const id = String(req.query.id || '')
    if (!/^\d+$/.test(id)) {
      res.status(400).json({ code: 400, message: '缺少歌曲 id' })
      return
    }
    const level = AUDIO_LEVELS.includes(String(req.query.level))
      ? String(req.query.level)
      : 'standard'
    try {
      const cookie =
        (payload && payload.cookie) || (configured ? await sessionCookie() : '')
      if (!cookie) {
        res
          .status(401)
          .json({ code: 301, message: '还没有可用的网易云登录态，请先登录' })
        return
      }
      const result = await call(songUrlV1, {
        id,
        level,
        cookie,
        noCookie: true,
      })
      const first = result && result.body && result.body.data && result.body.data[0]
      if (!first || !first.url) {
        res.status(404).json({ code: 404, message: '这首歌暂时没有可播放的地址' })
        return
      }
      const range = req.get('range')
      const upstream = await axios.get(first.url, {
        responseType: 'stream',
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: range ? { Range: range } : {},
      })
      res.status(upstream.status)
      AUDIO_PASSTHROUGH.forEach((header) => {
        const value = upstream.headers[header]
        if (value) res.set(header, value)
      })
      res.set('Cache-Control', 'no-store')
      upstream.data.on('error', () => res.destroy())
      upstream.data.pipe(res)
    } catch (_) {
      if (res.headersSent) res.destroy()
      else res.status(502).json({ code: 502, message: '音频拉取失败' })
    }
  }

  router.get('/halfawake/stream', async (req, res) => {
    await proxyAudio(req, res, userSession.open(userToken(req)) || null)
  })

  router.post('/halfawake/user/captcha', async (req, res) => {
    const body = req.body || {}
    const phone = String(body.phone || '').trim()
    if (!/^\d{6,15}$/.test(phone)) {
      res.status(400).json({ code: 400, message: '手机号格式不对' })
      return
    }
    // 频率限制：同一手机号/设备 60 秒一条、1 小时 5 条，防止有人拿这个接口刷短信
    const device = String(req.get('x-device-id') || '').slice(0, 64)
    const limited =
      takeCaptchaSlot('phone:' + phone) ||
      (device ? takeCaptchaSlot('device:' + device) : '')
    if (limited) {
      res.status(200).json({ code: 429, message: limited })
      return
    }
    try {
      const result = await call(captchaSent, {
        phone,
        ctcode: String(body.ctcode || '86'),
        noCookie: true,
      })
      res.status(result.status || 200).json(publicBody(result))
    } catch (error) {
      res.status(200).json(loginFailureBody(error))
    }
  })

  router.post('/halfawake/user/login', async (req, res) => {
    if (!userSession.enabled) {
      res
        .status(503)
        .json({ code: 503, message: '服务端没配 NETEASE_SESSION_KEY' })
      return
    }
    const body = req.body || {}
    const phone = String(body.phone || '').trim()
    const captcha = String(body.captcha || '').trim()
    const password = String(body.password || '')
    if (!/^\d{6,15}$/.test(phone) || (!captcha && !password)) {
      res
        .status(400)
        .json({ code: 400, message: '请填手机号，以及验证码或密码' })
      return
    }
    try {
      const result = await call(loginCellphone, {
        phone,
        countrycode: String(body.countrycode || '86'),
        captcha: captcha || undefined,
        password: password || undefined,
        noCookie: true,
      })
      const payload = (result && result.body) || {}
      if (payload.code !== 200 || !result.cookie || !result.cookie.length) {
        res.status(200).json({
          code: payload.code || 502,
          message:
            payload.message || payload.msg || '登录失败，请检查手机号和验证码',
        })
        return
      }
      const cookie = mergeCookies('', result.cookie)
      const account = await inspect(cookie)
      const session = {
        cookie,
        exp: Date.now() + userSession.ttl,
        profile: account.profile || null,
        uid: (account.profile && account.profile.userId) || null,
      }
      res.json({
        code: 200,
        token: userSession.seal(session),
        profile: session.profile,
      })
    } catch (error) {
      // 上游非 200 时 request 会 reject，这里把网易的错误码原样告诉前端
      res.status(200).json(loginFailureBody(error))
    }
  })

  router.get('/halfawake/user/status', async (req, res) => {
    const raw = userSession.open(userToken(req))
    if (!raw) {
      res.json({ code: 200, loggedIn: false })
      return
    }
    const result = await refreshUserPayload(raw)
    res.json({
      code: 200,
      loggedIn: result.active,
      profile: result.payload.profile || null,
      token: result.token || undefined,
    })
  })

  router.post('/halfawake/user/logout', async (req, res) => {
    const payload = userSession.open(userToken(req))
    if (payload) {
      await call(logoutModule, { cookie: payload.cookie, noCookie: true }).catch(
        () => {},
      )
    }
    res.json({ code: 200 })
  })

  router.get('/halfawake/user/playlists', async (req, res) => {
    const payload = requireUser(req, res)
    if (!payload) return
    const uid = String(
      req.query.uid ||
        payload.uid ||
        (payload.profile && payload.profile.userId) ||
        '',
    )
    if (!uid) {
      res.json({ code: 301, message: '读不到账号信息，请重新登录' })
      return
    }
    try {
      const result = await call(userPlaylist, {
        uid,
        limit: numberParam(req.query.limit, { fallback: 50, min: 1, max: 100 }),
        offset: numberParam(req.query.offset, { fallback: 0, min: 0, max: 1000 }),
        cookie: payload.cookie,
        noCookie: true,
      })
      res.status(result.status || 200).json(publicBody(result))
    } catch (_) {
      res.status(502).json({ code: 502, message: '读取歌单失败' })
    }
  })

  router.get('/halfawake/user/playlist/tracks', async (req, res) => {
    const payload = requireUser(req, res)
    if (!payload) return
    try {
      const result = await call(playlistTrackAll, {
        id: String(req.query.id || ''),
        limit: numberParam(req.query.limit, { fallback: 100, min: 1, max: 200 }),
        cookie: payload.cookie,
        noCookie: true,
      })
      res.status(result.status || 200).json(publicBody(result))
    } catch (_) {
      res.status(502).json({ code: 502, message: '读取歌单歌曲失败' })
    }
  })

  router.get(
    '/halfawake/search',
    handle(cloudsearch, (req) => ({
      keywords: String(req.query.keywords || '').slice(0, 100),
      limit: numberParam(req.query.limit, { fallback: 20, min: 1, max: 30 }),
    })),
  )
  router.get(
    '/halfawake/playlists',
    requireConfigured,
    handle(
      userPlaylist,
      () => ({
        uid: process.env.HALFAWAKE_NETEASE_UID || '',
        limit: 50,
      }),
      { login: true },
    ),
  )
  router.get(
    '/halfawake/playlist/tracks',
    requireConfigured,
    handle(
      playlistTrackAll,
      (req) => ({
        id: String(req.query.id || ''),
        limit: numberParam(req.query.limit, {
          fallback: 100,
          min: 1,
          max: 200,
        }),
      }),
      { login: true },
    ),
  )
  router.get(
    '/halfawake/song/url',
    requireConfigured,
    handle(
      songUrlV1,
      (req) => ({
        id: String(req.query.id || ''),
        level: ['standard', 'higher', 'exhigh', 'lossless'].includes(
          String(req.query.level),
        )
          ? String(req.query.level)
          : 'standard',
      }),
      { login: true },
    ),
  )
  router.get(
    '/halfawake/lyric',
    handle(lyric, (req) => ({ id: String(req.query.id || '') })),
  )

  return router
}

module.exports = { createHalfawakeGateway }
