# QQ X 定时推送：GitHub Actions 直跑实验版

这个项目会在 GitHub Actions 里定时执行：

1. 启动 NapCat Docker。
2. 等待 QQ / OneBot HTTP 可用。
3. 检查指定 X/Twitter 账号是否有新推文。
4. 有新推文才发到 QQ 私聊或 QQ 群。
5. 保存最新推文记录，避免重复发送。
6. 停止 NapCat，等待下次定时运行。

这是“先在 GitHub 上直接跑”的实验版。如果 QQ 触发风控、扫码或设备验证，需要根据 Actions 日志继续处理。

## 依据

NapCat 官方文档说明：

- NapCat 支持 Linux Docker 部署。
- Docker 镜像支持 `3000`、`3001`、`6099` 端口。
- QQ 持久化数据路径是 `/app/.config/QQ`。
- NapCat 配置路径是 `/app/napcat/config`。
- NapCat 支持 OneBot HTTP 接口调用，包括 `send_private_msg` 和 `send_group_msg`。

本项目 workflow 会把这些目录挂载到 GitHub Actions 的 `.napcat-data`，并用 Actions cache 尝试在多次运行之间保留登录数据。

## 文件说明

```text
.github/workflows/send-qq-message.yml  GitHub Actions 定时任务
scripts/check-x-and-send.mjs           检查新推文并发送 QQ 消息
package.json                           Node.js 项目配置
.env.example                           本地配置示例
.gitignore                             防止上传密钥和本地运行缓存
state/latest-post.json                 自动生成，用于记录已处理推文
```

## GitHub 配置

进入你的 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions
```

### Secrets

添加：

```text
QQ_TARGET_ID
```

Value 填接收消息的 QQ 号或群号，例如：

```text
3583318150
```

可选添加：

```text
ONEBOT_ACCESS_TOKEN
```

如果你在 NapCat HTTP 服务里设置了访问令牌，这里填同一个 token。  
如果没有设置，可以先留空。

注意：这个直跑版本不需要填 `ONEBOT_HTTP_URL`，workflow 会在 GitHub Actions 里启动 NapCat，并使用：

```text
http://127.0.0.1:3000
```

### Variables

添加：

```text
QQ_TARGET_TYPE
```

Value：

```text
private
```

或者：

```text
group
```

添加：

```text
X_USERNAME
```

Value 填要监控的 X 用户名，不要带 `@`，例如：

```text
nico_nico_news
```

可选添加：

```text
X_RSS_URL
```

如果你有自己的 RSSHub 地址，可以填完整 RSS 地址，例如：

```text
https://你的-rsshub.example.com/twitter/user/nico_nico_news
```

如果留空，脚本默认使用：

```text
https://rsshub.app/twitter/user/你的用户名
```

可选添加：

```text
SEND_FIRST_RUN
```

推荐先填：

```text
0
```

意思是第一次运行只记录当前最新推文，不发送，避免把旧推文发出去。

如果希望第一次运行也发送当前最新推文，填：

```text
1
```

## 第一次运行

上传代码后，进入：

```text
Actions -> Check X and Send QQ Message -> Run workflow
```

第一次运行时，NapCat 可能还没有登录 QQ。你需要打开这次 Actions 的日志，重点看：

```text
Wait for NapCat login and OneBot HTTP
```

如果日志里出现二维码、登录 URL、设备验证或风控提示，就按日志提示处理。

如果登录成功，workflow 会继续发送测试消息或检查推文，并把 `.napcat-data` 保存到 Actions cache。之后定时运行会尝试恢复这份登录数据。

## 手动发送测试消息

进入：

```text
Actions -> Check X and Send QQ Message -> Run workflow
```

在 `message` 里填一条测试消息，例如：

```text
GitHub Actions NapCat 测试
```

这会跳过 X/RSS 检查，直接测试 QQ 发送链路。

## 定时频率

当前配置在 `.github/workflows/send-qq-message.yml`：

```yaml
- cron: "7,37 * * * *"
```

意思是每小时第 7 分钟和第 37 分钟各运行一次，大约每 30 分钟检查一次。

GitHub Actions 的 cron 使用 UTC 时间。如果你要改成北京时间每天 09:07 运行一次，可以写：

```yaml
- cron: "7 1 * * *"
```

## 常见失败

### 一直卡在等待 NapCat

看 Actions 日志里的 NapCat 输出。常见原因：

- 第一次登录需要扫码。
- QQ 触发设备验证。
- NapCat Docker 默认配置没有启用 OneBot HTTP。
- GitHub Actions 环境被 QQ 判定为异常登录环境。

### 发送接口失败

检查：

```text
QQ_TARGET_TYPE
QQ_TARGET_ID
ONEBOT_ACCESS_TOKEN
```

发私聊时：

```text
QQ_TARGET_TYPE=private
QQ_TARGET_ID=对方 QQ 号
```

发群聊时：

```text
QQ_TARGET_TYPE=group
QQ_TARGET_ID=群号
```

### 重复发送

项目会把最新推文记录在：

```text
state/latest-post.json
```

这个文件会由 GitHub Actions 自动提交更新。如果你删除它，下一次运行会重新把当前最新推文当作“第一次看到”。

## 本地预览

只预览不发送：

```powershell
$env:DRY_RUN="1"
$env:MANUAL_MESSAGE="本地预览消息"
node .\scripts\check-x-and-send.mjs
```

本地预览不会启动 NapCat Docker。
