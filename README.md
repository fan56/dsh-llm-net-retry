# dsh-llm-net-retry

[English](README.en.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：重试网关以
`finish_reason: "network_error"` 上报的模型请求失败——这类失败被 dsh 原生重试策略归为不可重试，
导致整个 turn 直接硬失败。

## 背景

一些 OpenAI 兼容网关（如 [OpenCode Zen](https://opencode.ai/zen)）把自身上游连接的瞬时失败
作为流的终止 `finish_reason` 上报，而不是走 HTTP/传输层错误。在 dsh `0.1.2-rc.1`（本插件
跟随的 rc/stable 线；alpha 线已退役）中，两条 adapter 路径仍把它误分类：

| 路径 | 产出的失败 | 原生分类 |
|---|---|---|
| `llm-pi-ai`（`openai-completions`） | `Provider finish_reason: network_error` | `PI_AI_ERROR`——不可重试 |
| `llm-deepseek` | `model stopped: network_error`，code `NETWORK_ERROR` | 不可重试 |

`dsh-llm-retry` 只重试 provider `retryableCodes` 里的码（`TRANSPORT`、`RATE_LIMIT`、`SERVER`、
`TIMEOUT`、`EMPTY_RESPONSE`），于是没人重试，turn——包括 subagent turn——直接失败。
而这类故障立即重试几乎总能成功。

opencode 在上游修过同样的问题：
[40282c1](https://github.com/anomalyco/opencode/commit/40282c1d4d5476e6b536a72c0baf3a27bcf0e4df)、
[e0b9e68](https://github.com/anomalyco/opencode/commit/e0b9e68a68a8bc8367d84e305efd114d0445348a)。

dsh 本体的修复已备好并充分测试（fork 分支
[`fix/network-error-retryable`](https://github.com/fan56/deepseek-harness/tree/fix/network-error-retryable)；
dsh 目前不接受外部 PR，已按官方渠道报告至
[Discussions #3949](https://github.com/deepseek-ai/deepseek-harness/discussions/3949)）。
在修复合入前，本插件就是解决方案；合入后它也无害：只在整个 `agent/request-error`
waterfall 弃权时才行动，且绝不触碰 llm-retry 自身的重试计数。

## 工作原理

插件挂在 `agent/request-error` waterfall 的**末端**：

1. 先调用 `next()`——provider 的策略执行器（`dsh-llm-retry`）先决策。任何一方决定重试，
   该决策原样透传。
2. 只有当所有 listener 都弃权，且失败消息命中漏网的 network 变体——`network_error` /
   `network-error` / `network error`，或 pi-ai 对未识别网关 stop reason 的
   `Provider finish_reason:` 渲染——才调度本插件自己的有界重试。
3. 重试持久化且可见：`llm/retry` / `llm/retry-started` session 事件，schema 与 llm-retry
   兼容，TUI 无需改动即可展示。计数使用本插件自己的 policy key（`net-retry:v1…`），
   绝不污染 llm-retry 的计数。

已被分类为 `TRANSPORT` 的失败（ECONNRESET、`terminated`、流截断、超时、HTTP 5xx）由原生
策略重试，本插件刻意不再重复匹配。

## 安装

本插件是独立的 dsh 插件，与宿主 UI 无关：装入**任意 dsh profile** 即可（把 `<profile>`
换成你的 profile 名——profile 由 `dsh` CLI 自建自管，不是 tui 专属）：

```bash
dsh plugin --profile <profile> add @aiwayds/dsh-llm-net-retry
```

包内的 `cordis.patch.yml` 会以插件 id `dsh-llm-net-retry` 挂载，挂在哪个 profile，
就对哪个 profile 启动的 dsh 实例生效（tui / web / 自定义 launcher 均可）。

> ⚠️ 所有 `@deepseek-ai/*` 包都是 peerDependencies（由 dsh 闭包解析）——绝不要把它们当普通
> dependencies 装进插件，否则会出现第二份 cordis 闭包和诡异的崩溃。

## 配置

```yaml
dsh-llm-net-retry:
  mode: on            # 'off' 完全摘除 listener
  maxRetries: 5
  backoff:
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
```

（`~/.dsh/settings.yaml` 里按插件 id 加段，与其他插件同机制。）

未知 key 报错。默认值对齐 llm-retry 原生策略（5 次重试、500 ms→10 s 指数退避、对称抖动 0.1）。

## 验证

- 单测：匹配表（正/负例）、注入随机数的退避计算、配置校验、真实 cordis context 上的决策链
  （透传/重试/计数/abort/mode off/下游异常韧性）。
- e2e：真实 agent loop + 真实 `llm-pi-ai` `openai-completions` adapter，打脚本化本地网关
  （前两次请求回 `finish_reason: "network_error"`）——第三次请求完成 turn、`llm/retry`
  事件落盘；负向对照（无插件）一次请求后 turn 即硬失败。
- 真实宿主：已在 dsh 0.1.0-rc.8 的 `--profile tui`（dsh-tui-pi）上实测，重试链
  （指数退避、稳定 retryId、事件落盘、TUI 展示）全部正确。

```bash
npm test        # 先构建：npm run build
```

e2e 在隔离的临时 `$HOME` 下运行，绝不触碰 `~/.dsh`。

## 兼容性

**要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

面向 dsh `>=0.1.2-rc.1` 的 `agent/request-error` waterfall 与 `llm/retry` 事件 schema。插件对
dsh 本体零侵入：无 monkey-patch、不替换服务，dispose 即干净移除。

## 许可证

MIT
