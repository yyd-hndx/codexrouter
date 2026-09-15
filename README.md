# codexRouter

一个 Codex skill：把编程任务交给 OpenCode、Grok Build、DeepSeek Harness 或 ZCode，Codex 负责写清需求、接收结果、检查代码。

## 解决的问题

省掉跨工具复制需求、盯进度和搬运结果的来回折腾，让 Codex 跟进到代码验收。

## 支持环境和 Agent

- 环境：Windows、Codex 桌面端、Node.js 24+、PowerShell 7、Git。
- Agent：OpenCode、Grok Build、DeepSeek Harness、ZCode（已有 API Key／自定义模型配置）。

## 功能

- **模型选择**：默认使用 Agent 当前配置的模型；用户明确指定时，按指定模型执行。
- **后台执行**：配置回调后，完成结果返回原对话，期间可以继续聊天。
- **压缩恢复**：记录待复审结果，可选 hook 提醒对话压缩后接着处理。
- **任务管理**：查询进度、停止任务、核对异常状态，避免重复派单。

## 分派和返修规则

- **分派**：用户可指定 Agent；未指定时，Codex 把简单任务交给默认 Agent（当前为 OpenCode），复杂任务自己处理。
- **返修**：Codex 独立 review；主动分派最多返修 1 次，用户指定 Agent 默认最多返修 3 次，用户可另设上限。首次实现不算返修，到上限后由 Codex 接手修完。

## 安装和使用

### 1. 安装 skill

需要 Windows、Git、Node.js 24+ 和 PowerShell 7。

在 PowerShell 中运行：

```powershell
git clone https://github.com/yyd-hndx/codexrouter.git "$env:USERPROFILE\.codex\skills\codexRouter"
cd "$env:USERPROFILE\.codex\skills\codexRouter"
npm ci --ignore-scripts
npm run doctor
```

如果设置了 `CODEX_HOME`，安装到它的 `skills/codexRouter` 目录。安装后在 Codex 中新开一个任务。

### 2. 配置执行器

选择一个执行器即可。下面以 DeepSeek Harness 为例：

```powershell
npm install --prefix .runtime/deepseek @deepseek-ai/dsh@0.1.5-rc.1
npm run configure -- --backend deepseek-harness --runtime .runtime/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js --provider deepseek-official --model deepseek-flash --effort max
```

在启动 Codex 的环境中设置 `DEEPSEEK_API_KEY`，模型名称换成你账号可用的，然后检查配置：

```powershell
npm run doctor -- --config config.local.json
```

使用 Grok Build 或 OpenCode，见[执行器配置](references/configuration.md)。OpenCode 不指定模型或档位时，使用它在当前项目中的默认配置；返修继续使用同一会话。

使用 ZCode，见[接入说明](references/zcode.md)，复用桌面端已有模型配置。

### 3. 配置完成通知

脚本会尝试发现当前 Codex 的回调组件，也支持显式指定本地路径。先在 Codex 的任务环境中检查；失败时按[回调配置](references/result-delivery.md#local-callback-channel)处理：

```powershell
node scripts/owner-notify.cjs probe
```

这样执行器做完后，结果才会回到原对话。没有可用的回调通道时，可以明确让 Codex 在当前回合等待。

需要在对话压缩后自动接着检查代码，可以按[恢复配置](references/compact-recovery.md)启用可选 hook。

### 4. 开始使用

在项目里对 Codex 说：

> 用 $codexRouter，让 DeepSeek 实现登录页，你负责 review。

换成你要用的 Agent 和任务即可。
