---
title: Astro + Fuwari + Cloudflare Pages 博客部署记录
published: 2026-06-08
description: 记录使用 Astro、Fuwari、GitHub 和 Cloudflare Pages 搭建个人静态博客的完整流程。
tags: [Astro, Fuwari, Cloudflare Pages, GitHub, Blog]
category: 建站
draft: false
---

## 前言

最近打算搭建一个个人博客，用来记录技术折腾、网络配置、AI 工具、服务器运维以及一些零散笔记。

因为这个博客是纯静态站点，不需要后端服务，也不涉及数据库，最终我选择了 **Cloudflare Pages**。

博客框架使用 **Astro**，主题选用 **Fuwari**。

整体的部署流程如下：

```text
本地 Astro / Fuwari 项目
→ GitHub 仓库
→ Cloudflare Pages 自动构建
→ 博客上线
```

## 创建 Fuwari 项目

我没有使用 Astro 的默认模板，而是直接通过 Fuwari 官方脚手架来创建项目。

在本地目录执行：

```powershell
cd D:\Astro
npm create fuwari@latest
```

按照提示创建项目，例如将项目命名为 `blog`。

进入项目目录：

```powershell
cd D:\Astro\blog
```

安装依赖：

```powershell
pnpm install
```

启动本地开发环境：

```powershell
pnpm dev
```

在浏览器中访问：

```text
http://localhost:4321
```

如果能正常看到页面，说明项目已经成功运行。

## 修改站点配置

Fuwari 的主要配置文件位于：

```text
src/config.ts
```

在这里可以修改以下内容：

```text
站点标题
站点描述
导航栏
头像
主题颜色
社交链接
```

修改后刷新页面即可检查配置是否生效。

## 本地构建测试

部署之前，建议先在本地完成一次构建测试。

执行：

```powershell
pnpm build
```

构建成功后，会生成 `dist` 目录，该目录就是最终部署到 Cloudflare Pages 的静态文件目录。

本地构建成功非常重要，因为 Cloudflare Pages 在线部署时执行的也是类似的构建流程。如果本地无法通过构建，线上部署通常也会失败。

## 初始化 Git 仓库

确认项目可以正常构建后，准备将代码推送到 GitHub。

初始化 Git 仓库：

```powershell
git init
```

添加全部文件：

```powershell
git add .
```

如果第一次提交时出现以下提示：

```text
Author identity unknown
```

说明 Git 尚未配置用户信息。配置用户名和邮箱：

```powershell
git config --global user.name "your-name"
git config --global user.email "your-email@example.com"
```

然后提交代码：

```powershell
git commit -m "init fuwari blog"
```

## 创建 GitHub 仓库

登录 GitHub，新建一个仓库，例如命名为 `blog`。

创建仓库时建议**不要**勾选以下选项：

```text
Add a README file
Add .gitignore
Choose a license
```

因为本地项目已经包含完整文件。如果仓库提前初始化了这些内容，首次推送时可能会出现历史记录冲突。

添加远程仓库（此处先使用 HTTPS 地址，稍后会解决认证问题）：

```powershell
git remote add origin https://github.com/your-username/blog.git
```

设置主分支名称：

```powershell
git branch -M main
```

## 解决 GitHub 推送认证问题

首次推送时，我遇到了 GitHub 的 HTTPS 认证错误：

```text
Password authentication is not supported for Git operations.
```

GitHub 已不再支持使用密码进行 Git 操作，目前推荐使用以下方式之一：

```text
Personal Access Token
GitHub CLI
SSH Key
```

这里我选择使用 SSH。

### 生成 SSH Key

执行：

```powershell
ssh-keygen -t ed25519 -C "your-email@example.com"
```

一路按回车即可。

### 查看公钥

执行：

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

复制输出的完整内容。

### 添加到 GitHub

进入：

```text
GitHub → Settings → SSH and GPG keys → New SSH key
```

填写：

```text
Title: Windows PC
Key type: Authentication Key
Key: 粘贴刚刚复制的公钥
```

### 测试连接

执行：

```powershell
ssh -T git@github.com
```

如果看到类似以下输出，说明 SSH 配置成功：

```text
Hi username! You've successfully authenticated, but GitHub does not provide shell access.
```

### 改用 SSH 地址推送

接下来将远程仓库地址改为 SSH 形式：

```powershell
git remote set-url origin git@github.com:your-username/blog.git
```

随后即可推送代码：

```powershell
git push -u origin main
```

推送完成后，就能在 GitHub 仓库中看到完整的项目文件了。

## 部署到 Cloudflare Pages

进入 Cloudflare 控制台：

```text
Workers & Pages
→ Create Application
→ Pages
→ Connect to Git
```

选择刚刚创建的 GitHub 仓库。

构建配置填写如下：

```text
Build command: pnpm build
Build output directory: dist
```

如果后续遇到 Node.js 版本问题，可以添加环境变量：

```text
NODE_VERSION=20
```

确认配置后开始部署。

部署完成后，Cloudflare Pages 会生成一个默认域名，例如：

```text
https://xxx.pages.dev
```

访问该地址即可查看博客。

## 后续更新流程

以后无论是修改配置、更新页面还是发布新文章，只需要在本地完成修改后执行：

```powershell
pnpm build
git add .
git commit -m "update blog"
git push
```

推送到 GitHub 后，Cloudflare Pages 会自动触发重新构建和部署。

整个更新流程如下：

```text
本地修改
→ git commit
→ git push
→ Cloudflare Pages 自动部署
→ 网站更新
```

## 文章与资源结构

Fuwari 的文章默认存放在：

```text
src/content/posts
```

普通文章可以直接创建 Markdown 文件：

```text
src/content/posts/my-first-post.md
```

如果文章包含图片等资源，推荐使用目录结构：

```text
src/content/posts/my-guide/
├── index.md
└── cover.png
```

这样可以将文章与相关资源放在同一个目录中，便于管理。

在文章中引用同目录图片：

```md
![封面](./cover.png)
```

如果只是纯文字内容，直接使用单个 `.md` 文件即可。

## 总结

本次博客部署主要完成了以下步骤：

```text
创建 Fuwari 项目
修改站点配置
本地构建测试
初始化 Git 仓库
推送到 GitHub
配置 SSH 认证
接入 Cloudflare Pages
完成自动部署
```

最终使用的技术栈：

```text
Astro
Fuwari
GitHub
Cloudflare Pages
```

对于个人静态博客来说，这套方案轻量、免费且维护成本低。后续只需要在本地编写文章并推送到 GitHub，Cloudflare Pages 就会自动完成构建和发布，非常适合作为长期使用的个人博客方案。
