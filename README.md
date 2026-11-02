# dsh-github-push (v0.2.0)

> DeepSeek Harness 插件与跨 Agent 全自动静默推送引擎：**一句话把本地目录可靠推送到 GitHub**。

专为 AI Coding Agent（DSH、Claude Code、Cursor、Cline 等）设计的零外部依赖 GitHub 发布体系。彻底解决传统 Agent 推送时「频繁反问确认、依赖外部 CLI 报错、过程日志污染主上下文、代理隧道 TLS 握手抖动、Token 泄漏进会话」等核心痛点。

---

## 核心设计与特性

1. **绝对静默与托收承办（Zero Confirmation）**
   - 彻底摒弃「向用户反问仓库名或公开私有」的设计缺陷；
   - **托收默认规则**：未显式说明开源时无条件默认设为 `private`（确保安全底线）；若远端已存在同名仓库则自动继承远端属性；
   - 仓库名自动根据目录名规范化；本地无 Git 自动初始化 `main` 分支；自动暂存并生成规范提交信息。

2. **大模型零信任凭据气闸（Credential Airlock）**
   - **大模型完全脱敏**：模型入参只需传递占位符 `{{vault:github}}`；
   - **本地安全翻译**：Windows 平台直接通过 Win32 API (`advapi32.dll::CredRead`) 从系统凭据管理器直读 Git 令牌；跨平台支持回退环境变量 `GITHUB_TOKEN`；
   - **动态 Scrub 过滤器**：所有子进程日志、网络错误堆栈与 JSON 报告均经由正则气闸清洗，真实 Token 永不出机、永不写入对话上下文、永不存入 `.git/config`。

3. **网络自愈与 TLS 加固**
   - 强制 Git 使用 OpenSSL 后端（`-c http.sslBackend=openssl`），彻底消除 Windows Schannel 在本地 HTTP 代理隧道下的间歇性握手抖动；
   - 智能多路代理探测（优先嗅探 `127.0.0.1:7890`，备选 `7897`、`10808` 及环境变量），网络不可达时快速失败报警，拒绝无限挂起；
   - 关键网络操作（鉴权、API 建仓、Git 推送）内置 3 次指数退避重试；双通道（`git ls-remote` + REST API）回读远端 SHA 比对核验。

4. **主会话零上下文污染**
   - 支持通过轻量子代理（`subagent`）单步承办，所有中间 Git 报文在子代理独立内存中销毁；
   - 主会话历史仅接收最终的 3 行结构化成功卡片，对首字延迟（TTFT）与上下文预算零负担。

---

## 痛点对比表

| 常见问题 | 传统做法 / v0.1.0 | v0.2.0 加固引擎 |
|---|---|---|
| 命令执行报 gh 未找到 | 强制依赖外部安装 GitHub CLI | 纯 Node.js 原生 + 系统 Git，彻底消除 gh 依赖 |
| 反复停下来向用户提问 | 强制 ask 选项，中途打断用户 | 托收默认规则，默认 private，全程零交互确认 |
| 代理隧道 TLS 握手假失败 | 默认 Windows Schannel 偶发抖动 | 显式指定 OpenSSL 后端 + 3次退避重试，0 抖动 |
| 凭据容易泄露给大模型 | 环境变量或命令参数携带明文 Token | 零信任凭据气闸，模型仅见占位符，本地内存直读 |
| 大量 Git 日志拖慢会话 | 主会话逐步敲命令打印 50+ 行日志 | 支持子代理单步隔离执行，主会话零日志污染 |

---

## 快速使用

### 1. 作为独立 CLI 运行

```bash
# 全托收静默推送当前项目（默认 private）
node bin/push.mjs --dir "C:\path\to\project"

# 明确指定公开开源
node bin/push.mjs --dir "C:\path\to\project" --visibility public

# 仅做预检（干跑）
node bin/push.mjs --dir "C:\path\to\project" --dryRun
```

### 2. 作为 DSH 插件安装

本插件是标准 DSH host 插件。在 `cordis.patch.yml` 中添加配置：

```yaml
- insert:
    - id: github-push
      name: 'dsh-github-push'
```

启动 DSH 后，Agent 即可调用原生模型工具 `github_push`。

### 3. 作为 AI Agent 调度使用

在 Agent 系统规则中引入约定：

```javascript
// 主 Agent 仅需发起 1 次子代理调用：
subagent({
  description: "静默推送代码到 GitHub",
  prompt: "执行以下命令将目录推送到 GitHub：\nnode bin/push.mjs --dir \"<绝对路径>\"\n执行完成后仅汇报最终卡片，严禁向用户提问确认。"
});
```

---

## License

[MIT](LICENSE)
