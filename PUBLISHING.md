# 自动发布文章

把文章放进项目根目录的 `publish-inbox`，然后运行：

```powershell
npm.cmd run publish-posts
```

脚本会依次完成：

1. 导入文章到 `src/content/posts`
2. 补齐缺失的 frontmatter
3. 规范文章文件名和 URL slug
4. 运行 Biome、Astro 类型检查和生产构建
5. 创建 Git commit
6. 推送到当前分支的 `origin`
7. 把原稿移到 `publish-inbox/_published`

## 支持的输入

单文件文章：

```text
publish-inbox/
└── my-new-post.md
```

带图片等资源的文章目录：

```text
publish-inbox/
└── my-new-post/
    ├── index.md
    └── cover.png
```

文章缺少 `title`、`description`、`tags` 或 `category` 时，脚本会调用 Anthropic Messages API 分析正文并生成这些字段。已有且非空的字段不会被覆盖。

首次使用时复制配置文件：

```powershell
Copy-Item publish.config.example.json publish.config.json
```

然后编辑 `publish.config.json`：

```json
{
	"anthropic": {
		"apiKey": "你的 Anthropic API Key",
		"model": "claude-sonnet-4-6",
		"baseUrl": "https://api.anthropic.com",
		"maxTokens": 1024,
		"timeoutMs": 60000
	}
}
```

`publish.config.json` 已加入 `.gitignore`，不会被提交到 GitHub。需要更换模型时直接修改 `model`。

AI 会生成：

```yaml
---
title: AI 根据正文生成
published: 当前日期
description: AI 根据正文生成摘要
tags: [AI 识别的标签]
category: AI 识别的分类
draft: false
---
```

`published` 和 `draft` 属于发布策略，不由 AI 决定。frontmatter 已完整时不会调用 API，也不会产生 API 费用。

## 只检查不发布

```powershell
npm.cmd run publish-posts -- --dry-run
```

该模式会完整执行导入、检查和构建，然后删除临时导入内容，不会 commit 或 push。

## 安全限制

- 正式发布前，Git 工作区必须是干净状态。
- 目标文章已存在时，脚本会停止，避免覆盖已有内容。
- 检查或构建失败时，不会提交或推送。
- 如果 push 失败，已经创建的本地 commit 会保留，修复网络或认证后可手动执行 `git push`。
