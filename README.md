# codexrouter

一个 Codex skill：把编程任务交给 OpenCode、Grok Build 或 DeepSeek Harness，Codex 负责写清需求、接收结果、检查代码。

## 解决的问题

- 不用在几个工具之间来回复制需求和结果。
- 任务在后台执行，当前对话可以继续做别的事。
- 执行器说“完成”后，Codex 会检查实际改动；有问题就让它继续修，默认最多三轮。

## 安装和使用

### 1. 安装 skill

需要 Windows、Git、Node.js 24+ 和 PowerShell 7。

在 PowerShell 中运行：

```powershell
git clone https://github.com/yyd-hndx/codexrouter.git "$env:USERPROFILE\.codex\skills\codexrouter"
cd "$env:USERPROFILE\.codex\skills\codexrouter"
npm ci --ignore-scripts
npm run doctor
```

如果设置了 `CODEX_HOME`，安装到它的 `skills/codexrouter` 目录。安装后在 Codex 中新开一个任务。

### 2. 配置执行器

三个执行器任选一个。下面以 DeepSeek Harness 为例：

```powershell
npm install --prefix .runtime/deepseek @deepseek-ai/dsh@0.1.5-rc.1
npm run configure -- --backend deepseek-harness --runtime .runtime/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js --provider deepseek-official --model deepseek-flash --effort max
```

在启动 Codex 的环境中设置 `DEEPSEEK_API_KEY`，模型名称换成你账号可用的，然后检查配置：

```powershell
npm run doctor -- --config config.local.json
```

使用 Grok Build 或 OpenCode，见[执行器配置](references/configuration.md)。

DeepSeek 在 Windows 上遇到命令权限或连接超时问题，见[排查步骤](references/deepseek-troubleshooting.md)。

### 3. 配置完成通知

按[回调配置](references/result-delivery.md#local-callback-channel)连接本机 Codex App Tools，然后在 Codex 的任务环境中检查：

```powershell
node scripts/owner-notify.cjs probe
```

这样执行器做完后，结果才会回到原对话。没有可用的回调通道时，可以明确让 Codex 在当前回合等待。

需要在对话压缩后自动接着检查代码，可以按[恢复配置](references/compact-recovery.md)启用可选 hook。

### 4. 开始使用

在要修改的项目里对 Codex 说：

> 使用 $codexrouter，让 DeepSeek Harness 实现登录页。配置用 skill 目录下的 config.local.json。你负责检查结果，有问题继续修，最多三轮。

把执行器和任务换成你需要的即可。
