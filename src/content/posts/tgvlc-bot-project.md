---
title: 一个基于 Telegram Bot 联动 VLC 播放器的小项目
published: 2026-06-09
description: 记录 TgVLC_Bot 的开发背景、部署流程和使用体验，一个通过 Telegram Bot 远程控制 Windows VLC 播放器的小工具。
tags: [Telegram Bot, VLC, Python, WebSocket, NAS]
category: 项目
draft: false
---

最近用 Codex 辅助写了一个小项目：**TgVLC_Bot**。

项目地址：[BakaNoble/TgVLC_Bot](https://github.com/BakaNoble/TgVLC_Bot)

这个项目的用途很简单：通过 Telegram Bot 控制 Windows 电脑上的 VLC 播放器，让别人也可以远程点播我 NAS 里的番剧。

## 为什么要写这个项目

我的番剧基本都放在 NAS 里，平时通过 Windows 电脑上的 VLC 播放。

问题是，有时候我和朋友在语音频道里聊天，朋友突然想看某一集番剧，而我又懒得动，不想切窗口、不想翻目录，也不想一集一集手动找。

所以我就想做一个小工具：

```text
朋友在 Telegram Bot 里浏览番剧目录
朋友自己点选想看的文件
我的 Windows 电脑自动用 VLC 播放
播放中还可以远程暂停、快进、调音量、切下一集
```

这样我只需要把 Bot 权限给朋友，他就可以自己点播。

对我来说，这个项目本质上不是一个复杂的媒体系统，而是一个比较懒人化的“番剧遥控器”。

## 它能做什么

目前 TgVLC_Bot 支持这些功能：

```text
浏览本地视频目录
浏览 WebDAV / NAS 视频目录
通过 Telegram 点播视频
控制 VLC 播放 / 暂停 / 停止
快进 / 后退
调节音量
切换全屏
切换字幕
上一集 / 下一集
用户白名单
管理员审核
```

比较适合的场景是：

```text
视频文件放在 NAS 或本地硬盘里
VLC 运行在 Windows 电脑上
朋友想远程点播视频
自己懒得手动操作播放器
已经有一台 VPS 可以部署 Bot 服务端
```

它不是 Jellyfin、Emby、Plex 这类完整媒体库系统，也不负责网页播放和转码。

它更像是：

```text
Telegram Bot + VLC + NAS 的远程点播遥控器
```

## 项目大致结构

这个项目分成两部分：

```text
服务端：运行 Telegram Bot，部署在 VPS 上
客户端：运行在 Windows 电脑上，负责控制 VLC 和访问 NAS
```

整体流程大概是：

```text
朋友点击 Telegram Bot
        ↓
服务端收到点播命令
        ↓
服务端通过 WebSocket 发给 Windows 客户端
        ↓
Windows 客户端访问 NAS 或本地目录
        ↓
调用 VLC 播放对应视频
```

这样设计的好处是，NAS 不需要暴露到公网。

服务端只负责 Bot 和命令转发，真正访问 NAS、读取视频目录、控制 VLC 的都是 Windows 客户端。

## 部署准备

你需要准备这些东西：

```text
一台可以访问 Telegram API 的 VPS
一个 Telegram Bot Token
一台 Windows 电脑
Windows 上安装好 VLC
NAS 或本地视频目录
Python 环境
Docker / Docker Compose
```

如果你的视频在 NAS 上，建议 NAS 提供 WebDAV 服务。

例如：

```text
http://192.168.1.100:5005/dav
```

只要 Windows 客户端能访问这个 WebDAV 地址即可，VPS 不需要能访问 NAS。

## 第一步：创建 Telegram Bot

先在 Telegram 里找到：

```text
@BotFather
```

发送：

```text
/newbot
```

按照提示创建 Bot。

创建完成后，BotFather 会给你一个 Token，格式大概是：

```text
1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

这个 Token 后面要写入服务端配置。

## 第二步：获取自己的 Telegram 用户 ID

为了设置管理员权限，需要先知道自己的 Telegram 用户 ID。

可以使用类似下面的 Bot 查询：

```text
@userinfobot
```

或者其他能查询 Telegram ID 的工具。

拿到自己的数字 ID 后，后面填入配置文件里的 `admin_user_ids`。

例如：

```yaml
admin_user_ids:
  - 123456789
```

## 第三步：部署服务端

服务端推荐部署在 VPS 上。

先拉取项目：

```bash
git clone https://github.com/BakaNoble/TgVLC_Bot.git
cd TgVLC_Bot
```

复制服务端配置文件：

```bash
cp server/config.yaml.example server/config.yaml
```

编辑配置：

```bash
nano server/config.yaml
```

主要需要修改这些内容：

```yaml
telegram:
  token: "YOUR_TELEGRAM_BOT_TOKEN"

websocket:
  host: "0.0.0.0"
  port: 8765
  auth_token: "your-secret-key-here"
  heartbeat_timeout: 90

security:
  allowed_user_ids: []
  admin_user_ids:
    - 123456789

proxy:
  enabled: false
  type: socks5
  host: 127.0.0.1
  port: 1080
  username: ""
  password: ""
```

其中：

```text
telegram.token        填 Telegram Bot Token
websocket.port        服务端 WebSocket 端口
websocket.auth_token  客户端连接服务端用的密钥
admin_user_ids        管理员 Telegram 用户 ID
allowed_user_ids      允许使用 Bot 的用户 ID
```

如果 `allowed_user_ids` 为空，表示暂时不限制普通用户。正式部署前建议配置用户白名单，避免任何找到 Bot 的人都能发送控制命令。

如果你希望只有指定用户能使用，就可以写成：

```yaml
security:
  allowed_user_ids:
    - 111111111
    - 222222222
  admin_user_ids:
    - 123456789
```

如果 VPS 访问 Telegram API 需要代理，可以把代理打开：

```yaml
proxy:
  enabled: true
  type: socks5
  host: 127.0.0.1
  port: 1080
  username: ""
  password: ""
```

配置完成后启动服务端：

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f
```

如果日志里没有明显报错，服务端就启动完成了。

## 第四步：放行服务端端口

服务端默认使用 WebSocket 端口：

```text
8765
```

如果你的 VPS 开了防火墙，需要放行这个端口。

例如使用 UFW：

```bash
ufw allow 8765/tcp
```

如果使用云服务器安全组，也需要在控制台放行：

```text
TCP 8765
```

客户端后面会通过这个端口连接服务端。

> 公网暴露 WebSocket 端口时，请使用足够长的随机 `auth_token`，并优先通过 WSS 反向代理、VPN，或防火墙源 IP 白名单保护连接。不要直接使用示例密钥。

## 第五步：配置 Windows 客户端

Windows 客户端负责真正控制 VLC 和访问 NAS。

先在 Windows 上安装 Python，并确认可以执行：

```powershell
python --version
```

然后进入项目目录，安装客户端依赖：

```powershell
pip install -r client/requirements.txt
```

复制客户端配置文件：

```powershell
copy client\config.yaml.example client\config.yaml
```

编辑：

```powershell
notepad client\config.yaml
```

重点配置如下：

```yaml
server:
  url: "ws://your-server-ip:8765"
  auth_token: "your-secret-key-here"
  reconnect_interval: 5

vlc:
  path: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"

video:
  directories:
    - "D:\\Videos"
  extensions:
    - .mp4
    - .avi
    - .mkv
    - .mov
    - .wmv
    - .flv
    - .webm
    - .m4v
    - .mpg
    - .mpeg

controls:
  volume_step: 10
  seek_step: 30
  page_size: 10

webdav:
  - name: "NAS"
    url: "http://192.168.1.100:5005/dav"
    username: "admin"
    password: "password"
```

需要注意：

```text
server.url         改成你的 VPS 地址
server.auth_token  必须和服务端配置一致
vlc.path           改成你本机 VLC 的路径
video.directories  改成本地视频目录
webdav.url         改成你的 NAS WebDAV 地址
```

如果你的视频都在 NAS 里，本地目录可以少写或不写，重点配置 WebDAV。

## 第六步：启动 Windows 客户端

在 Windows 项目目录中运行：

```powershell
python -m client.vlc_client
```

如果连接成功，服务端日志里应该能看到客户端上线。

此时打开 Telegram Bot，发送：

```text
/start
```

应该能看到控制菜单。

如果配置了 WebDAV，就可以在 Bot 菜单里浏览 NAS 视频目录并点播。

## 第七步：测试播放

建议按这个顺序测试：

```text
1. Telegram Bot 是否能正常回复 /start
2. Windows 客户端是否成功连接服务端
3. Bot 是否能显示本地目录或 WebDAV 目录
4. 点击视频后 VLC 是否能自动打开
5. 播放 / 暂停 / 快进 / 音量控制是否正常
6. 上一集 / 下一集是否能正常切换
```

如果点播后 VLC 没反应，优先检查：

```text
VLC 路径是否正确
Windows 客户端是否在线
server.auth_token 是否一致
WebDAV 地址、用户名、密码是否正确
Windows 电脑是否能访问 NAS
服务端 8765 端口是否放行
```

## 可选：打包 Windows 客户端

如果不想每次都用 Python 命令运行，可以打包成 exe。

安装 PyInstaller：

```powershell
pip install pyinstaller
```

执行打包：

```powershell
pyinstaller client.spec --clean --noconfirm
```

打包完成后，程序会出现在：

```text
dist\TgVLC_Client.exe
```

之后可以把下面两个东西放在同一个目录：

```text
TgVLC_Client.exe
config.yaml
```

双击运行即可。

如果希望开机自动运行，可以把快捷方式放到 Windows 启动目录。

按下：

```text
Win + R
```

输入：

```text
shell:startup
```

然后把客户端快捷方式放进去。

## 使用体验

实际用起来以后，体验还挺符合我的需求。

以前朋友想看哪一集，我需要自己去 NAS 目录里找，然后再拖进 VLC。

现在流程变成了：

```text
朋友打开 Telegram Bot
自己进入番剧目录
自己点选想看的集数
我的电脑自动用 VLC 播放
```

如果播放过程中要暂停、快进、切下一集，也可以直接在 Telegram 里操作。

对我来说，这个工具最大的价值不是技术多复杂，而是它解决了一个很具体的小麻烦：

```text
朋友想看番，但我懒得动。
```

## Codex 的作用

这个项目主要是通过 Codex 辅助完成的。

我负责提出需求和判断方向，例如：

```text
番剧在 NAS 里 / 在某个 WebDAV 里
朋友需要通过 Telegram 点播
VLC 运行在 Windows 上
NAS 不应该暴露到公网
需要用户权限控制
最好能 Docker 部署服务端
```

Codex 则主要帮助我完成代码实现、配置文件、项目结构和 README。

这类小工具很适合用 AI 辅助开发。

因为需求边界比较清楚，不需要做成大型系统，只要把几个功能串起来：

```text
Telegram Bot
WebSocket
Windows 客户端
VLC
NAS / WebDAV
```

最后就能得到一个可用的小工具。

## 总结

TgVLC_Bot 是一个很偏个人需求的项目。

它不是为了替代完整媒体库，也不是为了做复杂的流媒体服务，而是为了解决一个非常实际的场景：

```text
番剧在 NAS 里，朋友在语音频道里想看，我懒得动，就让他自己点。
```

现在只要服务端和 Windows 客户端都在线，朋友就可以直接通过 Telegram Bot 浏览番剧目录、点播视频，并控制 VLC 播放。

对我来说，这就是 AI 辅助开发最舒服的一种用法：不一定要做很大的项目，而是把生活里一个具体的小痛点，快速搓成一个真正能用的工具。

项目地址：[BakaNoble/TgVLC_Bot](https://github.com/BakaNoble/TgVLC_Bot)
