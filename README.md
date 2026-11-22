# dsh-plugin-sim

**给 DeepSeek Harness 的本地防复发记忆。** SIM 记住同一仓库里已复现的错误与随后实际跑通的修法。下一次遇到匹配报错，SIM 在工具结果里递一条简短提示。工具顺利运行时，SIM 保持静默。

## 安装

将发布包 `dsh-plugin-sim-0.1.0.tgz` 下载到本机。通过 Harness 插件管理器安装本地发布包，或在已安装 `dsh` 的终端运行以下命令。`web` 可换成实际 profile 名，首次安装后重启该 profile。

```sh
dsh plugin --profile web add /absolute/path/dsh-plugin-sim-0.1.0.tgz
```

源码检出可先执行 `npm ci && npm run build`，再把绝对目录传给同一条 `add` 命令。该插件的运行时仅使用 Node.js 标准库和宿主已提供的钩子。Node.js 22.18+。集成测试覆盖 Harness `0.2.1-rc.3` 和 `0.2.2-rc.5` 的 Cordis、工具执行和会话 API。[Harness 安装文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.html)

## 一个例子

1. 模型在仓库里运行 `npm test`，收到包管理器错误。
2. 同一任务里改用 `pnpm test`，退出码为 `0`。SIM 写入一条记录。
3. 另一个模型直接运行 `pnpm test` 时没有任何提示。如果它也在同一目录遇到相同错误，工具结果会显示历史失败输入、验证过的修法和修复依据。

| 命令 | 用途 |
| --- | --- |
| `/sim status` | 查看当前项目的热、降权、冷却及标星条目统计 |
| `/sim list` | 查看当前项目最近验证的 25 条记录及其 ID |
| `/sim pin <id>` | 允许活跃条目在当前模型再次提交自己曾失败的原参数时事前提示 |
| `/sim drop <id>` | 按完整 ID 删除账本记录。未来出现新的已验证闭环时可重新学习 |

### 捕获、提示与淘汰

- SIM 观察原生模型工具调用。`bash`、`pwsh` 的同步前台结果以实际退出码为准，工具参数校验以 `INVALID_ARGS` 为准。同一个会话任务、模型、工具、工作目录和可比较操作，在随后四步内以修订的输入成功，才会形成记录。相同输入重试需要观察到同目录内的成功编辑。
- 指纹先去掉动态诊断数据，再计算 SHA-256。工作目录与任务相符时优先精确匹配。词法回退同时要求相同的具体诊断标志、高词汇重合度和同一个失败输入。多个修法相互冲突时保持静默。
- 事后模式可跨模型提供建议。自动事前拦截要求三次已验证闭环、至少两个曾失败的模型、足够置信度，以及当前模型曾用相同输入失败。标星可替代频率门槛。两种事前入口都要求当前模型有精确失败证据。反复只在单个模型出现的参数问题标为 `model_scoped`，其他模型遇到相同报错仍可收到事后提示。
- 一次提示后，下一步使用原验证修法并成功会更新置信度。相同报错继续出现时降为 `stale`，连续两次失效后进入 `archived`。新修法跑通会记录 `supersedes`。超过 30 天未命中或未获验证的条目会移出热索引。
- v0.1 聚焦原生工具调用。PTC / `run_code` 的内部调用、后台任务、取消、超时、沙箱拒绝和含多段 Shell 控制字符的命令不参与学习。救场状态显示在该次工具结果中。

## Token 核算

| 场景 | SIM 增开请求 | SIM 新增输入 |
| --- | ---: | --- |
| 捕获、清洗、匹配、持久化和斜杠命令 | 0 | 0 |
| 正常工具调用，无历史提示触发 | 0 | 0 |
| 指纹命中或一次事前拦截 | 0 | 一条短提示，通常约 60–100 Token，实际以供应商分词为准 |

SIM 不调用外部或本地模型，不使用 embedding，也不注册 System Prompt 或工具 schema。注入只改变命中的会话工具结果。历史提示只供相同路由的下一步读取，随后通过 Harness 原生 surface replacement 从模型输入中撤回。切换路由时会在组装请求前撤回。同一步发生供应商级重试时仍会携带该提示。原始工具结果和用户可见提示保留在 Harness 的会话日志中。供应商可能重新计算受替换影响的会话后缀缓存，System Prompt 文本由宿主控制。每次救场的输入确实参与正常请求的计费，节省量取决于它避免了多少盲目重试。

## 本地数据

默认写入 `$DSH_HOME/sim/ledger.json`。未设置 `DSH_HOME` 时使用 `~/.dsh`。仓库和执行目录以本地规范路径的哈希分区。报错只保存特征哈希。可复用的短命令、参数和编辑路径可能含有项目私有信息。插件跳过明显的凭证字段、敏感命令片段和文件正文。账本适合留在本机。多个 Harness 进程通过独占写锁、重新读取和原子替换共享账本。当进程被强制终止并残留 `ledger.json.lock` 时，先关闭使用这份账本的 Harness 实例，再移除该锁文件。

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
| `agent/request` | 请求组装前处理已过期或属于其他路由的提示 |
| `ctx.commands.register` | 注册 `/sim` 及其子命令 |

集成测试使用本地、确定性的工具夹具，无需 API Key。`npm pack` 会重新编译并产出可上传到 GitHub Release 的 `.tgz`。
