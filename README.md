# codexRouter

一个 Codex skill：把编程任务交给 OpenCode、Grok Build 或 DeepSeek Harness，Codex 负责写清需求、接收结果、检查代码。

## 解决的问题

省掉跨工具复制需求、盯进度和搬运结果的来回折腾，让 Codex 跟进到代码验收。

## 功能

- **执行器选择**：支持 OpenCode、Grok Build、DeepSeek Harness，可指定模型和推理档位。
- **后台执行**：配置回调后，完成结果返回原对话，期间可以继续聊天。
- **主动分派**：简单明确的 UI、普通 CRUD 可交给已配置的 OpenCode Grok，复杂逻辑由 Codex 处理。
- **复审修复**：主动分派最多返修 1 次，用户指定执行器默认最多返修 3 次；到上限后 Codex 接手，仍解决不了再讨论。首次实现不算返修。
- **压缩恢复**：记录待复审结果，可选 hook 提醒对话压缩后接着处理。
- **任务管理**：查询进度、停止任务、核对异常状态，避免重复派单。
- **环境排查**：提供 DeepSeek Windows 权限与网络检查，以及按需启用的系统/新解析地址回退；模型请求重试留在原会话。

## 分派和返修规则

你的执行器、模型、停止或“自己做”要求优先。没指定执行器时，Codex 可把范围明确的界面调整、表单接线、普通 CRUD 交给已配置的 OpenCode Grok；权限、并发、运行时协议等复杂工作由 Codex 处理。

| 场景 | 最多返修 | 最多提交次数 |
| --- | ---: | ---: |
| Codex 主动分派的简单任务 | 1 次 | 2 次 |
| 用户指定执行器，未另设上限 | 3 次 | 4 次 |

首次实现不算返修。每次都由 Codex 独立检查代码和验证结果；到上限后停止外部执行器，由 Codex 修完。Codex 也解决不了时，再带具体问题与你讨论。只要求 review，不会擅自派发实现任务。

## 断线时会怎样

DeepSeek Harness 在原会话、原步骤内重试临时模型请求错误；桥接层记录重试次数、等待状态和最终错误码，不把整项任务重新提交。重试耗尽或进程异常时保留会话 ID、请求和已有结果，先核对现场；取消后不会自动重启。

默认沿用系统网络。遇到已确认的 DNS 地址问题，可配置 `--dns-mode auto`，保留系统地址并补充新解析地址；不会固定 IP、跳过证书验证或偷偷换服务商。VPN、节点和服务端状态仍会影响连通性，任何 skill 都不能保证网络永不断线。

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

脚本会尝试发现当前 Codex 的回调组件，也支持显式指定本地路径。先在 Codex 的任务环境中检查；失败时按[回调配置](references/result-delivery.md#local-callback-channel)处理：

```powershell
node scripts/owner-notify.cjs probe
```

这样执行器做完后，结果才会回到原对话。没有可用的回调通道时，可以明确让 Codex 在当前回合等待。

需要在对话压缩后自动接着检查代码，可以按[恢复配置](references/compact-recovery.md)启用可选 hook。

### 4. 开始使用

在要修改的项目里对 Codex 说：

> 使用 $codexRouter，让 DeepSeek Harness 实现登录页。配置用 skill 目录下的 config.local.json。你负责检查结果，最多返修三次，之后你接手修完。

把执行器和任务换成你需要的即可。

## 可移植性与验证范围

- 共享代码不包含作者的账号、密钥、模型供应商编号或私人项目路径；执行器模型和本机运行目录由配置提供。
- 生成的 DeepSeek 配置在启动时按当前安装位置生成观察器路径，技能改名不会继续引用旧目录。换电脑后仍需安装执行器、配置凭据并重新生成本机配置。
- 当前验证环境是 **Windows + Node.js 24 + PowerShell 7**，没有宣称 macOS/Linux 已获完整支持。
- `doctor` 检查本机依赖与配置，不能替代真实模型请求；测试和限制见[验证记录](VALIDATION.md)。
