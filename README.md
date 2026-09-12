# OpenCode Review

让 OpenCode、Grok Build 或 DeepSeek Harness 执行任务，由 Codex 负责限定范围、接收结果和独立复审。

A Codex skill and local bridge for delegating authorized work to three executors, receiving the exact result, and independently reviewing it. Windows-first, version 0.2.0.

## 它解决什么问题

- 默认先写任务规格，确认派单后释放当前对话；执行器完成后，回调原对话进行独立复审。
- 请求、会话和回复 ID 必须对得上；超时不自动重复派单，压缩摘要不冒充最终结果。
- 修改未通过复审时，默认最多三轮修复，复用同一执行会话。
- 默认异步回调依赖可用的 Codex 桌面 App Tools；派单前检查通道，失败时明确选择降级方式。

## 开始使用

要求 **Windows、Node.js 24+、PowerShell 7（pwsh）**。其他系统尚未验证。

下载或克隆仓库，进入仓库目录：

```powershell
node --version
npm ci --ignore-scripts
npm run doctor
npm test
```

`doctor` 不带配置时只检查开发环境。测试使用本地模拟执行器，不读取真实 API 密钥、不调用收费模型。Windows 全套测试通常需要几分钟。

安装为技能：将整个仓库放到 Codex 的 `skills/opencode-review` 目录，在该目录执行 `npm ci --ignore-scripts`，然后重新打开 Codex 任务以刷新技能。若已有同名技能，先备份并在独立目录试用，不覆盖运行中的桥接。仓库目录既是技能目录，也是运行代码目录，不能只复制 `SKILL.md`。

## 选择一个执行器

| 执行器 | 配置方式 | 本地实现参考版本 |
|---|---|---|
| OpenCode | 已配置的 provider ID、model ID、variant | opencode-ai 1.18.29 |
| Grok Build | Node 运行入口、模型、推理档位、API 地址 | @xai-official/grok 1.0.25 |
| DeepSeek Harness | Node 运行入口、provider、模型、推理档位 | @deepseek-ai/dsh 0.1.5-rc.1 |

这些是适配时检查的版本，不代表你的账号一定有示例模型权限。指定实际可用的模型，不要静默换模型凑成功。

Grok Build 配置示例（运行时另行安装）：

```powershell
npm install --prefix .runtime/grok @xai-official/grok@1.0.25
npm run configure -- --backend grok-build --runtime .runtime/grok/node_modules/@xai-official/grok/bin/grok --model grok-4.6 --effort xhigh
```

默认使用官方 API 地址及环境变量 `XAI_API_KEY`。自定义服务用 `--base-url` 和 `--key-env` 指定，密钥值本身不要放进命令、示例文件或 Git。

Grok 推理流空闲超时默认 300 秒，可用 `--idle-timeout-seconds 600` 调整。它控制多久没有流数据就由运行时中止，与桥接的无进展告警、整个任务总时限是三件事。

DeepSeek Harness 示例：

```powershell
npm install --prefix .runtime/deepseek @deepseek-ai/dsh@0.1.5-rc.1
npm run configure -- --backend deepseek-harness --runtime .runtime/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js --provider deepseek-official --model deepseek-flash --effort max
```

设置 `DEEPSEEK_API_KEY`，并确认该运行时实际提供你指定的 provider/model。生成器只写本地配置，不派发模型任务。它会生成 `config.local.json`、隔离的运行目录及 DeepSeek observer 补丁；现有后端配置不会被覆盖。运行时迁移后需要重新生成/核对本地绝对路径。

```powershell
npm run doctor -- --config config.local.json
```

实际使用时对 Codex 说：

> 使用 opencode-review，用 DeepSeek Harness 实现这个项目中的指定修改，使用本技能目录的 config.local.json。你负责检查结果，最多三轮。

手动桥接命令与完整复审步骤见 [原生执行器](references/native-bridge.md)。OpenCode 的服务启动、空会话创建、初始化与接收步骤见 [OpenCode 配置](references/configuration.md) 和 [OpenCode 工作流](references/opencode.md)。

## 支持边界

- **默认异步**：通过 App Tools 的 `send_message_to_thread` 向原对话提交完成事件。需配置本机 MCP 服务入口，见 [结果接收](references/result-delivery.md)。仓库只提供路径模板，不包含个人配置；此通道依赖应用内部接口，升级后可能需要调整。
- **直接返回**：仅在明确要求当前回合等待时启用 `direct`，通过有界 wait 接收结果。
- **队列通知**：`events` 只代表通知入队，不保证自动提交或唤醒。
- **降级检查**：回调在发送前明确不可用时，可用原对话 heartbeat 定时检查。两种机制都不可用就报告限制、保留交接记录，不默认占着对话等。电脑和应用需保持可用。
- OpenCode 和 DeepSeek 的压缩链有模拟测试；真实长上下文自然触发压缩的 DeepSeek/Grok Build 完整端到端调用尚未验证。
- OpenCode 当前通过追加 dispatch 标记绑定请求；要求“逐字发送，不能加任何字符”时使用原生后端，或明确告知该限制。
- 默认工具权限为拒绝。任务明确授权执行工具时，按原生工作流选择 `allow_once`；执行器不是安全沙箱。
- Legacy OpenCode 每个安装目录只有一个活动 cycle；不同 Codex 任务不能同时抢占它。原生桥接每个项目仅允许一个活动 cycle。

## 发布与贡献

```powershell
npm test
npm run check:release
```

Windows CI 会执行同样的检查。发布扫描只显示文件名和问题类型，不打印疑似密钥。它是启发式检查，不保证发现所有秘密；首次发布请使用清理后的目录，已有 Git 仓库还需要扫描全部历史。

扫描范围是拟发布源码和所有已跟踪文件，包括后来被 ignore 的已跟踪文件；未跟踪且被 ignore 的本地凭据/运行目录不在发布扫描范围内，不要把它当成全硬盘秘密扫描器。

运行状态、凭据、日志和模型安装目录都在 `.gitignore` 中。不要上传真实 `*.local.json`（包括回调配置）、`.local`、`.runtime`、`.agent-work` 或 `legacy/work`。

采用 [MIT 许可证](LICENSE)。第三方运行时单独安装，遵循各自许可证，见 [依赖说明](THIRD_PARTY_NOTICES.md)。问题报告请说明系统、Node/执行器版本、脱敏后的错误及复现步骤；敏感信息按 [安全说明](SECURITY.md) 处理。
