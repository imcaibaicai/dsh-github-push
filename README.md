# dsh-github-push

> DeepSeek Harness 插件：**一句话把本地目录推送到 GitHub**。

注册一个模型工具 `github_push`。你对 Agent 说「把这个项目开源到 GitHub」，它就能走完全程：
探测代理 → 自愈 gh 登录态 → 扫描密钥与个人信息 → 建仓/提交/推送 → 回读远端 SHA 校验。

内核来自 [outbox](https://github.com/imcaibaicai/outbox) 项目，本仓库是它的**发布产物**（内嵌内核由
`scripts/sync-plugin.mjs` 自动同步，不是手写的第二实现）。

## 它替你挡掉了什么

| 常见故障 | 处理方式 |
|---|---|
| `gh` 突然报未登录，但 `git push` 明明正常 | 登录态文件会被清空，token 却还在系统凭据管理器里 —— 自动取回并重新校验 |
| 代理时通时不通，或关掉代理后命令卡死 | 先探测 `127.0.0.1:7890`：通则**按次注入**，不通则只清掉指向该端口的陈旧变量后直连 |
| 推到一半卡在输密码 | 子进程一律禁止交互询问，宁可明确失败也不静默挂起 |
| 密钥被推上公开仓库 | 推送前扫描**即将提交的索引**，命中高危内容直接阻断并列出文件与行号 |
| 命令返回 0，但推的其实是旧东西 | 回读远端分支，要求**远端 SHA 严格等于本地 HEAD** 才算成功 |
| 仓库里写死了本机用户目录路径 | 扫描绝对路径中的用户名、身份证号、手机号等，命中后**禁止自动公开** |

## 工具契约：`github_push`

| 参数 | 必填 | 说明 |
|---|---|---|
| `dir` | ✅ | 要发布的目录，**必须是绝对路径** |
| `visibility` | ✅ | `public` / `private` / `ask` |
| `name` | | 远端仓库名，默认由目录名规整而来 |
| `description` | | 仓库描述 |
| `message` | | 提交信息 |
| `dryRun` | | 只预检，不提交不推送 |

**可见性规则（刻意设计成不能由模型代劳）**：用户明确说公开/开源才传 `public`；
明确说私有才传 `private`；**其它情况一律 `ask`** —— 此时工具不会创建任何远端仓库，
只做预检并返回需要确认的问题，由 Agent 拿去问用户。

安全闸门命中个人信息时，即使请求了 `public` 也会停下来要求逐条确认。

## 安装

本插件是标准的 DSH host 插件（在 `cordis.patch.yml` 里插一行 loader 行）。
把包放进 profile 的 `node_modules`，然后加一行：

```yaml
- insert:
    - id: github-push
      name: 'dsh-github-push'
```

**host 插件在启动时装载，必须完全退出 DSH 再重启才生效。**

> 不想装插件也行：同一份内核还有命令行外壳与 Agent 通用 `SKILL.md`，见 [outbox](https://github.com/imcaibaicai/outbox)。

## 相关项目

- [outbox](https://github.com/imcaibaicai/outbox) —— 内核本体，同时提供 CLI 与 Agent 通用 Skill
- [dsh-plugin-publish](https://github.com/suyukun/dsh-plugin-publish) —— 面向 Agent 技能的发布流程协议，与本插件互补

## License

MIT
