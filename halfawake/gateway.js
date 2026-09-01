const express = require('express')
const path = require('path')
const request = require('../util/request')
const cloudsearch = require('../module/cloudsearch')
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

const DAY = 24 * 60 * 60 * 1000

function bearerToken(req) {
  const header = req.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
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
  const database = process.env.HALFAWAKE_CLOUDBASE_DATABASE
  const cloudbaseApiKey = process.env.CLOUDBASE_APIKEY
  const encryptionKey = process.env.NETEASE_SESSION_KEY
  const adminToken = process.env.MUSIC_ADMIN_TOKEN
  const configured = Boolean(
    envId && database && cloudbaseApiKey && encryptionKey && adminToken,
  )
  let store = null
  if (configured) {
    store = new SessionStore({
      envId,
      database,
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
