# dsh-multi-folder

[English](README.md) | **中文**

> 为 DeepSeek Harness 项目提供**副工作目录**——不离开主工作区，同时编辑源码库、测试库与文档库。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/dsh-multi-folder)](https://www.npmjs.com/package/dsh-multi-folder)
[![GitHub issues](https://img.shields.io/github/issues/AngelosZou/dsh-multi-folder)](https://github.com/AngelosZou/dsh-multi-folder/issues)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 bundle，为一个 Project（工作区）提供一组**副工作目录**：

- Agent 的核心 `cwd` 等属性始终指向**主工作目录**；
- 在 **Workspace Write** 模式下，Agent 对配置的副工作目录拥有与主工作目录**同等的读取、写入、编辑与命令执行权限**——实现方式是重定向会话自身的沙箱策略根，因此每种模式语义都自然保持（`read-only` 依旧拒绝、`workspace-write` 放行、`danger-full-access` 放行）；
- 目录列表**注入系统提示词**，每次组装按会话求值；
- 配置变更通过**不打断的消息队列**通知 Agent——在下一次消息边界（用户发送或工具调用结束）送达，且**仅在目录集合实际变化时**发送；
- **会话开始前即可配置**：会话创建页（新会话界面）提供「多工作目录」入口（英文界面显示 "Multi-folder"），通过**无会话远程 API**（`multiFolder/*` 端点）读写同一份 per-workspace 配置——无需 session id；
- **`@` 文件菜单能搜到副目录里的文件**：DSH 自带的 `@` 菜单只在主工作区内检索，因此本插件额外贡献自己的 `@` 分组，按目录成组列出副工作目录中的文件；
- **不新增任何工具**：改动全部位于框架级（工具流水线拦截）与 UI 级（会话级头部入口）。

## 环境要求

- Node.js >= 20
- 由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 组成的 DSH profile

## 安装

将本仓库链接进 DSH profile：

```bash
dsh plugin --profile web add dsh-multi-folder
```

然后**重启 DSH 后端**（宿主组合在进程启动时装载）并**刷新浏览器页面**（客户端 bundle 以 `no-cache` 提供）。

## 兼容性

请选择与你的 DeepSeek Harness 版本匹配的插件版本：

| DeepSeek Harness | 安装 |
| --- | --- |
| 0.1.1 及更早 | `dsh-multi-folder@0.1.7` |
| 0.1.2-alpha 及更新 | 最新版 `dsh-multi-folder` |

## 使用

会话头部出现「多工作目录」按钮（英文界面显示 "Multi-folder"）；**会话创建页**的入口位于**输入框上方**——与 git 分支胶囊同一条 dock 带，左边缘对齐新会话界面的工作区/预设胶囊，点击后面板以锚定在该胶囊上的浮层展开。会话创建页始终只显示**一个**入口：插件注册三个候选座位并选用当前可用的最佳者（上游 `conversation.hero.workspaceExtras` chip > `conversation.input.dock` 行 > 两者皆未声明时的右下角浮动按钮）。打开面板即可：

| 操作 | 行为 |
| ---- | ---- |
| 添加目录 | `native` 使用系统文件夹对话框，失败后尝试宿主对话框；`browse` 直接打开插件自带浏览器（路径输入框 + 一级子目录列表 + 可新建文件夹） |
| 在文件管理器中打开 | 在宿主机器的文件管理器（资源管理器 / Finder）中打开某个已配置目录 |
| 移除 / 刷新 | 立即生效 |
| 切换会话 | 面板自动切换为该会话的副工作目录 |
| 重新打开面板 | 使用会话级缓存，不产生冗余命令行 |

等价的用户斜杠命令：

```
/multi-folder list
/multi-folder add "D:\path\to\repo"
/multi-folder remove "D:\path\to\repo"
/multi-folder set "D:\a" "D:\b"
```

Agent 无需任何额外操作：`read` / `glob` / `grep` 随处可用；`write` / `edit` / `pwsh` / `bash` 在路径（或 `workdir`）落入副目录时自动拦截并以该目录为沙箱根执行。

### 用 `@` 查找副目录文件

在输入框输入 `@`，除主工作区文件外，还会按每个已配置的副工作目录显示一个分组——数据来自插件自己的 `multiFolder/listFiles` 端点：

| 输入 | 结果 |
| ---- | ---- |
| `@` | 每个已配置目录一行——即入口 |
| `@probe` | 所有副目录中匹配的文件与目录，按其所在目录分组显示 |
| `@secondary-spike/src/` | 列出该层级（目录优先） |
| `@D:/repos/other/src/` | 用绝对路径写出同一层级 |

选中一行会插入**绝对路径**引用（`@D:/repos/other/src/main.ts`）——因为副目录位于主工作区之外，从主工作区出发的任何相对路径都无法到达。目录行同样支持 `Tab` 逐层下钻。

这是一个**并列分组，而不是对自带菜单的改动**：DSH 自己的 `@` provider 只检索会话工作区，本插件完全不改它。未配置任何副目录的工作区行为与从前完全一致。

## 权限模型

每条受沙箱约束的命令只拥有**唯一一个可写根**——即本次调用被换根到的那个目录（Windows ACL runner 为每个进程树只授予一个工作区写 SID）。由此：

- cwd 停留在**主工作区**的命令**不能在副目录创建文件**。`git -C <副目录> commit`、脚本内 `cd <副目录>`、`git clone <url> <副目录>`、按绝对路径写文件等都会以操作系统级 `Permission denied` 失败（例如 `fatal: Unable to create '.../.git/index.lock': Permission denied`）。
- 对称地，被换根到副目录的命令在同一次调用中也**不能写主工作区**（或另一个副目录）。
- **创建文件的命令必须把 `workdir` 设为它要写入的目录，且必须使用该目录的绝对路径**——相对 `workdir` 只会相对主工作区解析；在命令内部切换进程目录（`Set-Location` / `cd`）也不会扩大可写根（写入会以操作系统级拒绝失败，Windows 错误码 5）。对 git 而言，请进入仓库目录执行（`workdir` 指向该仓库），而不是从主工作区用 `git -C`。该规则同样适用于 `run_in_background: true` 的后台任务。
- 读操作不受限制，无需 `workdir`。

当 shell 命令以这类拒绝失败且命令引用了已配置的副目录时，插件会在工具结果后附带一条简短的诊断提示，说明 workdir 的修正方式。**后台任务**的拒绝发生在工具调用返回之后，只出现在该任务的 `job_output` 输出里，那时不会再附带提示——请读取任务输出，并用绝对 `workdir` 重跑。

## 工作原理

- **拦截**——监听 `tools/execute` 环绕分派瀑布，对解析路径（或 `workdir`）落在副目录内的 `write` / `edit` / `pwsh` / `bash` 调用短路，并以**换根后的会话站立策略**（`{ ...standingPolicy, workspaceRoot: secondaryDir }`）执行。模式本身不变，因此各种沙箱模式与主工作区的语义天然一致。匹配前先经 `fs.resolve` + `processPath` 规范化，`..`、符号链接与大小写差异均正确处理。
- **提示词注入**——一个有序 `systemPrompt` 段落，text provider 每次组装按会话求值，仅为配置了副目录的会话渲染。
- **通知**——命令处理器仅在目录集合实际变化时置位 pending notice；`agent/pre-step`（前置注入进入批次）与 `tools/post-execute`（附加为 `additionalContexts`）两个通道中先触发者消费——均使用框架原生的插件来源 `notice` 上下文。
- **配置与安全边界**——per-workspace 配置存储于 Agent 沙箱之外的宿主自有目录（`<DSH_HOME>/storages/multi-folder/<workspace-key>.json`）。对配置文件的任何直接 `write`/`edit` 都会收到显式拒绝——**Agent 永远无法自我授予目录，配置权仅属于用户**。详见 [SECURITY.md](SECURITY.md)。
- **无会话远程 API**——经 `ctx.typert.register` 注册 `multiFolder` 命名空间（手写 `src-json` 描述符），并以普通对象服务 `multiFolder` 提供；`list`/`add`/`remove`/`set` 以工作区**路径**为键，与 `/multi-folder` 命令共享同一套校验核心，因此会话尚未建立时创建页也能直接配置。`browse`/`makeDir` 服务于自带浏览器；`pick`/`reveal` 负责选择或打开宿主目录。
- **目录选择**——`multiFolder/pick` 先调用宿主的 `native` 选择器，失败后尝试系统对话框；`browse` 能力直接打开客户端浏览器。关闭面板会取消请求；取消系统对话框不会添加目录。Windows 助手为 `lib/native-picker.ps1`。
- **`@` 发现**——同一 `fs` seam 的第二种用法：`multiFolder/listFiles` 为已配置目录建立索引（广度优先、按规范化路径去重以免 junction 绕回、排除生成物/依赖目录名、按工作区限量并短 TTL 缓存），客户端再据此注册一个并列的 `@` source。自带 provider 不做任何修改，自带分组也不受影响：触发器注册表以 `(trigger, name)` 为键，每个 source 各渲染一个分组。
- **客户端**——手写维护的 factory bundle（`window.__ModuleLoader__.load`），无需构建工具链；面板经两条通道驱动宿主：会话内走 Remote BFF（`ctx.remote.commands.execute`），无会话端点走共享 `/api` RPC 通道（`ctx.connection.rpc.call`）。

## 目录结构

| 路径 | 作用 |
| ---- | ---- |
| `cordis.patch.yml` | profile patch 层，插入 `dsh-multi-folder` 行 |
| `lib/index.js` | 宿主插件：配置、工具拦截、远程 API、目录选择器和文件管理器 |
| `lib/client.js` | 客户端面板、自带浏览器和并列 `@` 来源 |
| `lib/native-picker.ps1` | Windows 文件夹选择器助手 |
| `test/` | 免 DSH 运行时的行为测试（见开发） |
| `docs/` | 设计与分析文档 |

## 开发

零构建步骤：宿主半边为纯 ESM，`lib/client.js` 为 DSH client-modules 格式的手写 factory bundle。测试直接用 Node 运行：

```bash
node test/smoke-host.mjs    # 宿主 apply 冒烟 + 远程 API 行为
node test/intercept.mjs     # 拦截 / 命令 / 通知行为
node test/smoke-client.mjs  # 客户端 bundle 与面板流程（React shim）
```

修改 `lib/client.js` 前请先阅读 [docs/design.md](docs/design.md) 中的 bundle 契约。

## 文档

- [docs/design.md](docs/design.md) — 架构与安全模型（英文）
- [docs/upstream-hero-slot.md](docs/upstream-hero-slot.md) — 上游 `conversation.hero.workspaceExtras` 插槽改动（B1）与插件的对接方式（英文）

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎提交 issue 与 PR。

## 许可证

[MIT](LICENSE)
