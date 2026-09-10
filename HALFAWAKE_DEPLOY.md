# Half Awake 网易云会话部署

## 创建私有会话表

在 CloudBase 的 `SQL 型数据库 -> SQL 编辑器` 中执行
`cloudbase/migrations/20260901121000_create_netease_session.sql`。表启用 RLS 且不创建匿名策略。

## CloudBase 环境变量

在现有云托管服务的新版本中保留原有变量，并新增：

```env
HALFAWAKE_CLOUDBASE_ENV_ID=half-awake-d9g69y6lb5d5f79b0
HALFAWAKE_CLOUDBASE_DATABASE=pgdb-i6izmvlb
HALFAWAKE_CLOUDBASE_SCHEMA=public
CLOUDBASE_APIKEY=CloudBase服务端APIKey
NETEASE_SESSION_KEY=至少32字节随机密钥
MUSIC_ADMIN_TOKEN=至少32字节随机管理密钥
HALFAWAKE_NETEASE_UID=1937961682
```

`HALFAWAKE_CLOUDBASE_DATABASE` 用作 SQL REST 的实例 ID，必须使用 SQL 编辑器中
`SELECT current_database()` 返回的值，不能填写 CloudBase 环境 ID。
`HALFAWAKE_CLOUDBASE_SCHEMA` 是表所在的 PostgreSQL Schema，默认是 `public`。

体验版共享集群不需要配置数据库密码、内网地址或 `DATABASE_URL`。

在 PowerShell 中生成两个独立密钥：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

第一个填入 `NETEASE_SESSION_KEY`，第二个填入 `MUSIC_ADMIN_TOKEN`。不要将密钥提交到 GitHub。

## 首次登录

部署成功后打开：

```text
https://half-awake-306542-11-1454995027.sh.run.tcloudbase.com/halfawake-admin
```

输入 `MUSIC_ADMIN_TOKEN`，点击“检查”，再点击“重新扫码”。使用网易云音乐 App
扫码并在 App 内确认。Cookie 会在服务端加密后写入 PostgreSQL，不会返回给博客。

## 自动保活

Fork 内的 `.github/workflows/refresh-music-session.yml` 每日运行一次。到 GitHub 仓库的
`Settings -> Secrets and variables -> Actions` 新增：

```text
MUSIC_API_URL=https://half-awake-306542-11-1454995027.sh.run.tcloudbase.com
MUSIC_ADMIN_TOKEN=与 CloudBase 中完全相同的管理密钥
```

工作流每天检查一次，距上次刷新不足 7 天时不会重复刷新。可以在 Actions 页面手动运行
一次 `Refresh music session` 验证配置。

## 博客环境变量

EdgeOne Pages 只需要：

```env
PUBLIC_NETEASE_API_URL=https://half-awake-306542-11-1454995027.sh.run.tcloudbase.com
```

`PUBLIC_NETEASE_UID` 已不再使用，可以删除。先部署 API 并完成首次扫码，再部署博客。

## 用户各自登录（小程序）

除站长会话外，`/halfawake/user/*` 让每个用户登录自己的网易云账号。**不需要建表、不需要迁移**：
登录成功后服务端把该用户的网易云 cookie 用 `NETEASE_SESSION_KEY` 做 AES-256-GCM 密封成 token，
客户端只存 token，每次请求带回来，服务端解开用。cookie 永远不会下发到客户端。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/halfawake/user/captcha` | POST | body `{ phone, ctcode? }`，发短信验证码；同手机号/设备 60 秒 1 条、1 小时 5 条 |
| `/halfawake/user/login` | POST | body `{ phone, captcha }` 或 `{ phone, password }`，成功返回 `{ token, profile }` |
| `/halfawake/user/status` | GET | 带 `Authorization: Bearer <token>`；顺带用 `login_refresh` 续期，续上了会返回新 `token` |
| `/halfawake/user/logout` | POST | 尽力通知网易云登出，客户端丢掉 token 即可 |
| `/halfawake/user/playlists` | GET | 该用户的歌单（需要 token） |
| `/halfawake/user/playlist/tracks` | GET | 该用户某个歌单的歌曲（需要 token） |
| `/halfawake/stream` | GET | **音频代理**，`?id=&level=standard`，透传 `Range`；支持 `?token=`（音频没法带请求头） |

`/halfawake/stream` 是给小程序真机用的：网易给的播放地址是 `http://m*.music.126.net/...`，
小程序真机只允许 https 且域名不可配置，所以必须由本服务转成自己域名的 https。

管理员的 `MUSIC_ADMIN_TOKEN` **只认请求头**（`bearerToken`），不接受 `?token=`，避免密钥进 URL / 日志；
用户 token 才额外认 `?token=`（`userToken`），因为 `wx.createInnerAudioContext` 带不了请求头。

**登录可能被网易风控拦（返回 `code: -462` 要求人机验证）**，小程序里渲染不了那个验证页，
所以接口会明确回一条提示；公共曲库（站点会话）不受影响，未登录照样能搜能听。

## 上线后自测

不需要新增环境变量，沿用现有的即可（`NETEASE_SESSION_KEY` 必须已配置，否则 `/user/*` 返回 503）。

```text
GET  /halfawake/user/status                -> {"code":200,"loggedIn":false}
POST /halfawake/user/login  假验证码        -> {"code":-462,...} 或 {"code":400,...}（说明链路通）
GET  /halfawake/stream?id=347230           -> 不带 token 时走站点会话，应返回音频流而不是 401
GET  /halfawake/search?keywords=test       -> 原来的公共接口不受影响
```

