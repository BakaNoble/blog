---
title: "博客维护记录：升级 Astro 5.18.2，顺手修复构建隐患"
published: 2026-10-22
description: "记录一次 Astro / Fuwari 博客维护：整合 Dependabot 更新、排查 link class 构建错误、明确 Node 与 pnpm 版本，并通过 GitHub Actions 和 Cloudflare Pages 完成发布验证。"
image: ""
tags: [Astro, Fuwari, Cloudflare Pages, GitHub Actions, 博客维护]
category: 建站
draft: false
lang: zh-CN
---

这次给博客做了一次集中维护，将 Astro 从 **5.13.10 升级到 5.18.2**，同时更新了一批依赖。

过程继续由 Codex 协助检查和执行。原本以为主要工作是处理两个 Dependabot PR 的冲突，实际验证时还碰到了一处现有的样式构建隐患，于是一起修掉，并补全了 CI 的检查范围。

博客依然使用 Astro + Fuwari + Cloudflare Pages，站点配置、已有文章和自动发布脚本都保留了下来。这篇文章记录本次升级的处理方式，也给以后的维护留个参照。

## 这次更新了哪些内容

仓库里当时有两组待合并的更新：

- [PR #10](https://github.com/BakaNoble/blog/pull/10)：补丁版本更新。
- [PR #13](https://github.com/BakaNoble/blog/pull/13)：包含 Astro 在内的次版本更新。

两组更新都修改了 `package.json` 和 `pnpm-lock.yaml`，各自的检查已经通过，但直接连续合并会在依赖文件中产生冲突。因此，这次将两组更新整合到一个升级分支，处理完锁文件后，再验证最终的依赖组合。

主要版本变化如下：

| 组件 | 升级前 | 升级后 |
| --- | --- | --- |
| Astro | 5.13.10 | 5.18.2 |
| Svelte | 5.39.8 | 5.56.9 |
| `@astrojs/svelte` | 7.2.3 | 7.2.5 |
| Expressive Code 相关包 | 0.41.4 | 0.44.1 |
| Pagefind | 1.4.0 | 1.5.2 |
| `sanitize-html` | 2.17.0 | 2.17.6 |
| Biome | 2.2.5 | 2.5.9 |

pnpm 继续使用项目原先指定的 **9.14.4**。这次升级的范围是上面两组更新及必要的构建修补，没有同时进行 Astro 跨大版本迁移。

## CI 通过之后，还是遇到了构建错误

本地复测时，生产构建曾出现下面的错误：

```text
The `link` class does not exist.
If `link` is a custom class, make sure it is defined within a `@layer` directive.
```

报错位置在 `src/styles/markdown.css`。其中有一段样式会通过 `@apply` 使用自定义的 `link` 类，而这个类定义在 `src/styles/main.css` 中。

排查中有一个容易误判的地方：切换安装环境后，某次构建成功了，但同样的错误后来也在原主分支中出现。因此，不能直接把问题归因于某个新依赖或 pnpm 版本，也不能凭单次构建成功就判断问题已经解决。

继续检查源码，发现了两个需要一起处理的问题：图片导入范围过大，以及全局样式缺少显式入口。

### 图片组件扫描了整个源码目录

原来的 `ImageWrapper.astro` 使用下面的写法查找本地图片：

```ts
const files = import.meta.glob<ImageMetadata>("../../**", {
  import: "default",
});
```

这个匹配范围包含了图片以外的源码和样式文件。它们也会进入动态导入图，增加了无关模块参与构建的机会。

这次将范围收窄到当前使用的图片格式：

```ts
const files = import.meta.glob<ImageMetadata>(
  "../../**/*.{avif,gif,jpeg,jpg,png,svg,tiff,webp}",
  {
    import: "default",
  },
);
```

图片组件现在只负责查找图片，不再顺带把其他源码纳入导入范围。

### 为全局样式补上明确的加载入口

只缩小图片扫描范围还不够。原来的 `GlobalStyles.astro` 基本是空的，布局里也没有通过它显式加载这些全局样式。

因此，这次补全了 `GlobalStyles.astro`：

```astro
---
import "../styles/variables.styl";
import "../styles/markdown-extend.styl";
---

<style is:global>
@import "../styles/main.css";
@import "../styles/markdown.css";
@import "../styles/transition.css";
@import "../styles/scrollbar.css";
@import "../styles/photoswipe.css";
@import "../styles/expressive-code.css";
</style>
```

这里将基础组件样式和 Markdown 样式放进同一个明确的导入入口，让 PostCSS 在处理 Markdown 中的 `@apply link` 时，能够拿到相应的类定义。

随后在 `Layout.astro` 中导入这个组件，并在 `<head>` 中渲染：

```ts
import GlobalStyles from "@components/GlobalStyles.astro";
```

```html
<head>
  <GlobalStyles />
  <!-- 标题、元信息等其他内容 -->
</head>
```

修补后进行了重复构建，也重新生成了构建缓存进行验证，均通过了检查。

## 明确 Node.js 和 pnpm 版本

依赖更新后，还需要检查运行环境要求。例如，这次更新到的 `sanitize-html 2.17.6` 要求 **Node.js 22.12.0 或更高版本**。

所以，项目在 `package.json` 中补充了环境要求：

```json
{
  "packageManager": "pnpm@9.14.4",
  "engines": {
    "node": ">=22.12.0",
    "pnpm": "9.14.4"
  }
}
```

同时新增 `.node-version` 文件，内容为：

```text
24
```

本次本地验证使用的是 **Node.js 24.19.0 + pnpm 9.14.4**，CI 则分别测试 Node.js 22 和 24。

Cloudflare Pages 支持通过 `.node-version`、`.nvmrc` 或 `NODE_VERSION` 配置 Node.js 版本，也提供 `PNPM_VERSION` 环境变量。仓库里的配置和控制台中单独设置的版本应当保持一致，避免本地验证和线上构建使用不同环境。

这里也顺便补充一下：[最初的博客部署记录](/posts/astro-fuwari-cloudflare-pages-deploy/)中有 `NODE_VERSION=20` 的示例。更新到这次的依赖组合后，应当参考本篇的新环境要求。

## 将搜索索引生成纳入 CI

原来的构建工作流执行的是：

```sh
pnpm astro build
```

而项目在 `package.json` 中定义的完整构建命令是：

```json
{
  "scripts": {
    "build": "astro build && pagefind --site dist"
  }
}
```

两者的检查范围不同。`astro build` 完成页面生成后就结束了，`pnpm build` 还会继续生成 Pagefind 搜索索引。

这次将 CI 改为执行 `pnpm build`，让搜索索引生成失败也能在合并前暴露出来。另外还做了两处调整：

- Node.js 检查矩阵从 22 / 23 调整为 22 / 24。
- Biome 改为使用锁定依赖中的项目版本，通过 `pnpm exec biome ci` 执行。

这样，本地与 CI 使用的检查命令和工具版本更容易保持一致。

## 升级完成后如何验收

本地先完成冻结锁文件安装，再执行检查和完整构建：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec biome ci ./src
pnpm build
```

以下是升级验收当时的结果，尚不包含本文：

| 检查项目 | 结果 |
| --- | --- |
| Astro 检查 | 55 个文件，0 错误、0 警告 |
| Biome | 通过 |
| 页面生成 | 6 个 HTML 页面 |
| RSS | 包含原有 3 篇文章 |
| 站点地图 | 正常生成 |
| Pagefind | 建立 4 个页面的搜索索引 |

本地验证完成后，升级通过 [PR #14](https://github.com/BakaNoble/blog/pull/14) 提交。GitHub 上的 Node.js 22 / 24 检查、完整构建和代码规范检查全部通过，Cloudflare Pages 预览部署也成功了。

在预览站点中，又检查了首页、关于、归档、三篇文章，以及 RSS、站点地图、搜索脚本和部分静态资源。

最后合并到主分支，等待 Cloudflare Pages 生产部署完成，再访问主站确认：

- 首页和抽查文章的生成器版本已变为 `Astro v5.18.2`。
- 原有文章地址可以正常访问。
- RSS、站点地图和搜索资源能够正常获取。

只有完成这一步，才能确认升级后的文件确实已经在主站提供服务。

## 留给下一次维护的记录

这次升级最有用的收获，是把一次依赖更新中顺带暴露的构建隐患处理掉，并让检查覆盖到完整发布产物。

以后再更新博客时，可以继续沿用这套顺序：先在独立分支整合依赖和锁文件，再运行与生产一致的完整构建，通过预览部署验证页面，最后合并并检查主站。

本次升级前后的提交也都保留在 Git 历史中，后续排查可以直接对照：

| 节点 | 提交 |
| --- | --- |
| 升级前 | [`2f68445`](https://github.com/BakaNoble/blog/commit/2f68445ecac4a369fe865271335071f05c413be6) |
| 升级完成 | [`25b182c`](https://github.com/BakaNoble/blog/commit/25b182c31c38d4a6e16382f53b86da8e7463ee53) |

相关资料：

- [本次升级 PR #14](https://github.com/BakaNoble/blog/pull/14)
- [博客最初的部署记录](/posts/astro-fuwari-cloudflare-pages-deploy/)
- [Cloudflare Pages 构建环境说明](https://developers.cloudflare.com/pages/configuration/build-image/)
