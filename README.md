# dsh-plugin-sim

**给 DeepSeek Harness 的本地防复发记忆。** SIM 记住同一仓库里已复现的错误与随后实际跑通的修法。下一次遇到匹配报错，SIM 在工具结果里递一条简短提示。工具顺利运行时，SIM 保持静默。

## 安装

将发布包 `dsh-plugin-sim-0.2.0.tgz` 下载到本机。通过 Harness 插件管理器安装本地发布包，或在已安装 `dsh` 的终端运行以下命令。`web` 可换成实际 profile 名，首次安装后重启该 profile。

```sh
dsh plugin --profile web add /absolute/path/dsh-plugin-sim-0.2.0.tgz
```

源码检出可先执行 `npm ci && npm run build`，再把绝对目录传给同一条 `add` 命令。该插件的运行时仅使用 Node.js 标准库和宿主已提供的钩子。Node.js 22.18+。集成测试覆盖 Harness `0.2.1-rc.3` 和 `0.2.2-rc.5` 的 Cordis、工具执行和会话 API。[Harness 安装文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.html)

## 一个例子

1. 模型在仓库里运行 `npm test`，收到包管理器错误。
2. 同一任务里改用 `pnpm test`，退出码为 `0`。SIM 写入一条记录。
3. 另一个模型直接运行 `pnpm test` 时不会收到新提示。如果它也在同一目录遇到相同错误，工具结果会显示验证过的修法。字节预算允许时也会显示历史失败输入和来源模型。

| 命令 | 用途 |
| --- | --- |
| `/sim status` | 查看当前项目的热、降权、冷却及标星条目统计 |
| `/sim list` | 查看当前项目最近验证的 25 条记录及其 ID |
| `/sim pin <id>` | 允许活跃条目在当前模型再次提交自己曾失败的原参数时事前提示 |
| `/sim drop <id>` | 按完整 ID 删除账本记录。未来出现新的已验证闭环时可重新学习 |

### 捕获、提示与淘汰

- SIM 观察原生模型工具调用。`bash`、`pwsh` 的同步前台结果以实际退出码为准，工具参数校验以 `INVALID_ARGS` 为准。同一个会话任务、模型、工具、工作目录和可比较操作，在随后四步内以修订的输入成功，才会形成记录。相同输入重试需要观察到同目录内的成功编辑。
- 指纹去掉 PID、行列号等动态数据，再计算 SHA-256。目录内文件使用相对路径，目录外路径保留末两级目录信息。同一任务优先精确匹配。词法回退同时要求相同的诊断标志及路径、高词汇重合度和同一个失败输入。多个修法冲突时保持静默。升级保留 v0.1.0 账本。路径清洗变化后的旧指纹可能需要重新验证一次。
- 事后模式可跨模型提供建议。自动事前拦截要求三次已验证闭环、至少两个曾失败的模型、足够置信度，以及当前模型曾用相同输入失败。标星可替代频率门槛。只在单个模型上反复验证的参数或 Shell 失败标为 `model_scoped`，其他模型遇到相同报错仍可收到事后提示。
- 一次提示后，同一任务接下来四步内的重试可结算反馈，中间可以读文件或执行其他工具。推荐输入成功会更新置信度。推荐输入报出新错，或相关重试仍报同样的错，都会降为 `stale`。连续两次失效后进入 `archived`。新修法跑通后记录 `supersedes` 并继承失败模型证据，新修法的验证次数重新累计。超过 30 天未命中或未获验证的条目会移出热索引。
- v0.1 聚焦原生工具调用。PTC / `run_code` 的内部调用、后台任务、取消、超时、沙箱拒绝和含多段 Shell 控制字符的命令不参与学习。救场状态显示在该次工具结果中。

## Token 核算

| 场景 | SIM 增开请求 | SIM 新增输入 |
| --- | ---: | --- |
| 捕获、清洗、匹配、持久化和斜杠命令 | 0 | 0 |
| 正常工具调用，无历史提示触发 | 0 | 0 |
| 指纹命中或一次事前拦截 | 0 | 追加正文与标记最多 100 UTF-8 字节，供应商分词与消息封装另计 |

SIM 无模型调用和 embedding，System Prompt 与工具 schema 由 Harness 管理。仅命中时向工具结果追加短提示。过长的修法只显示预览，完整输入可在 `/sim list` 查看，此类修法跳过事前拦截。

默认保留已发送的提示，避免 SIM 改写已有消息前缀。保留下来的提示仍属于历史，切换模型后也可能随同一会话发送。需要隔离时，可在插件的 Cordis 节点下配置 `config.retireHintsOnModelSwitch: true`。启用后，只有 `agent/pre-step` 提供该步已捕获的 `modelSelection`，且路由与提示来源不同时，SIM 才撤回当前插件实例已记录的提示。`0.2.1-rc.3` 的钩子没有该字段，自动沿用默认策略。重新加载前的旧提示同样保留。选择启用撤回时，供应商可能重新计算被替换位置之后的会话缓存。

## 本地数据

默认写入 `$DSH_HOME/sim/ledger.json`。未设置 `DSH_HOME` 时使用 `~/.dsh`。仓库和执行目录以本地规范路径的哈希分区。报错只保存特征哈希。可复用的短命令、参数和编辑路径可能含有项目私有信息。插件跳过明显的凭证字段、敏感命令片段和文件正文。账本适合留在本机。

多个 Harness 进程通过独占写锁、重新读取和原子替换共享账本，最多保留 600 条。锁超过 30 秒且持有进程已退出时会自动回收。v0.1.0 遗留的空锁文件也会按 30 秒阈值回收。损坏的账本会在下一次有效写入时原样备份为 `ledger.json.corrupt.*`。无法识别的新版账本保留原样，等待兼容版本处理。

## SIM 论文映射

| 论文思路 | 本插件实现 |
| --- | --- |
| 记录尝试及评估上下文 | `context` 保存仓库、目录、工具、任务及来源模型 |
| 保留失败路径 | `failed_attempts` 保存 1–3 个失败输入及稳定指纹 |
| 记录修改动机和结果 | `verified_fix` 保存成功输入，`rationale` 保存参数差异或同命令成功的验证依据 |
| 重验与迭代 | 后续工具结果更新置信度、过期状态和 `supersedes` 链 |

实现借鉴 SIM 对失败、理由和验证结果的记录方式。捕获、选择与淘汰均由本地规则执行。[Self-Improvement Memory Enables Continual Recursive Self-Improvement](https://arxiv.org/abs/2611.18856)

## 开发与发布

```sh
npm ci
npm test
npm run test:integration
npm pack
```

| 路径 | 职责 |
| --- | --- |
| `src/engine.ts`、`src/types.ts` | 四元组、生命周期与命令控制面 |
| `src/fingerprint.ts`、`src/recipes.ts`、`src/project.ts` | 报错特征、操作关联及项目隔离 |
| `src/ledger.ts` | JSON 账本、并发写入和热数据时效 |
| `src/dsh-adapter.ts`、`src/surface.ts` | Cordis 连接和提示撤回 |
| `test/` | Node 原生单元测试与真实 Cordis 运行时集成夹具 |

| Cordis 入口 | 作用 |
| --- | --- |
| `session/event`、`session/disposed` | 用 assistant 实际路由与工具调用事件关联任务，清理临时状态 |
| `tools/pre-execute` | 在安全门之后检查精确匹配的高频或标星输入 |
| `tools/post-execute` | 观察工具结果，在匹配错误中追加提示 |
| `agent/pre-step` | 仅在启用隔离且确认切换路由时撤回当前实例已记录的提示 |
| `ctx.commands.register` | 注册 `/sim` 及其子命令 |

集成测试使用本地、确定性的工具夹具，无需 API Key。`npm pack` 会重新编译并产出可上传到 GitHub Release 的 `.tgz`。
