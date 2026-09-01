# Half Awake 网易云会话部署

## 创建私有会话表

在 CloudBase 的 `SQL 型数据库 -> SQL 编辑器` 中执行
`cloudbase/migrations/20260901121000_create_netease_session.sql`。表启用 RLS 且不创建匿名策略。

## CloudBase 环境变量

在现有云托管服务的新版本中保留原有变量，并新增：

```env
HALFAWAKE_CLOUDBASE_ENV_ID=half-awake-d9g69y6lb5d5f79b0
HALFAWAKE_CLOUDBASE_DATABASE=pgdb-i6izmvlb
CLOUDBASE_APIKEY=CloudBase服务端APIKey
NETEASE_SESSION_KEY=至少32字节随机密钥
MUSIC_ADMIN_TOKEN=至少32字节随机管理密钥
HALFAWAKE_NETEASE_UID=1937961682
```

`HALFAWAKE_CLOUDBASE_DATABASE` 必须使用 SQL 编辑器中
`SELECT current_database()` 返回的数据库名，不能填写 CloudBase 环境 ID。

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
