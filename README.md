# Antigravity Context Meter

专注、轻量的 Antigravity 桌面端上下文、速率、账号限额与每日用量监控插件，**零外部 npm 依赖**（无需运行 `npm install`）。

## 核心功能

- **对话栏胶囊（Inline Pill）**：紧凑嵌在对话输入框模型选择器右侧，按需展示核心指标（可在设置中自由开关，也支持极简模式）：
  - `context`：当前上下文占用的 Token 与百分比
  - `decode`：流式生成速度（`tok/s`）
  - `kv-cache`：KV 缓存命中率
  - `5h` / `weekly`：自动匹配当前模型的 5 小时与每周剩余额度占比
- **展开详情面板**：
  - **上下文窗口详情**：已用 Token、上限预算（支持自定义预算）、剩余空间、占比进度环、分段占比条（缓存读 / 新输入 / 写缓存 / 输出）及压缩回落估算
  - **生成性能与延迟**：输出速率、整体速度、首字延迟（TTFT）、生成耗时与会话平均速度
  - **配额重置倒计时**：同时查看 Gemini 与 Claude / GPT 两组 5 小时 / 每周额度剩余与重置时间
  - **会话与每日用量看板**：当前对话累计消耗、近 14 天每日趋势图、按模型消耗分布，以及外接 `codex-api` 等外部模型 API 的 `API` 用量汇总
- **全环境统一监控（含 SSH Remote）**：兼容本机与 **SSH Remote** 远端工作区窗口（自动复用 Antigravity 的 SSH SOCKS5 会话隧道），远端对话用量自动按唯一会话 UUID 去重合并至本机统一的每日用量账本。
- **双模式注入**：
  - **ASAR 持久化注入（`install` / `restore`）**：原生 `app.asar` 补丁，附带 SHA-256 备份校验与无损还原；安装时会自动清洗旧版注入残留并支持 Antigravity 2.34+ `loadHubWindowUrl`
  - **CDP 免改盘热注入（`live` / `watch`）**：通过 DevTools 端口实时注入并附带 `live-host` 本地桥接服务，适合免改盘试用、macOS 签名校验环境或渲染层调试

---

## 快速安装（推荐）

> [!IMPORTANT]
> **请勿让 Antigravity 对话框中的 AI 助手代为自动安装。**
> Antigravity 的安全护栏通常会拒绝修改宿主自身的 `app.asar`，且对话中的 AI 无法自行关闭正在运行的 Antigravity 主进程。
> 请在**系统外部终端**或**资源管理器中直接双击脚本**安装，并在安装前**完全退出 Antigravity（注意检查右下角系统托盘图标并右键退出）**。

### Windows 一键安装 / 卸载

1. 使用 `git clone https://github.com/lokinko/antigravity-context-viewer.git` 获取仓库，或下载 ZIP 后**完整解压到独立文件夹**（切勿直接在压缩包预览窗口中双击运行）。
2. **完全退出 Antigravity**（点击窗口右上角 `×` 可能会最小化到系统托盘，请右键点击系统托盘中的 Antigravity 图标 -> 退出）。
3. 双击 [install.bat](./install.bat) 完成安装。
   - **自定义安装路径**：若 Antigravity 安装在非默认目录，可在外部终端执行：
     ```bat
     install.bat --path "D:\your\path\to\resources\app.asar"
     ```
4. 重新打开 Antigravity，即可在输入框模型选择器右侧看到监控胶囊。

**卸载还原**：完全退出 Antigravity 后，双击 [uninstall.bat](./uninstall.bat) 即可通过备份与 SHA-256 校验无损还原原始 `app.asar`。

> [!NOTE]
> `install.bat` 与 `uninstall.bat` 会自动检测解压完整性与本机依赖：优先使用 Node.js 18+；若本机未单独安装 Node.js，会**自动复用 Antigravity 内置 Node 运行时（无需额外下载）**；若均未找到且系统自带 `winget`，会询问是否一键安装 Node.js LTS；若检测到 `app.asar` 被占用或需要管理员权限，会交互提示退出后重试或一键 UAC 提权。

### macOS / Linux 一键安装 / 卸载

```bash
chmod +x install.sh uninstall.sh
./install.sh     # macOS 若开启 ElectronAsarIntegrity 会提示改用 watch 模式
./uninstall.sh
```

脚本同样会自动查找本机 Node.js（18+）或回退复用 Antigravity 内置 Electron 运行时。

---

## 运行环境要求

| 使用方式 | 依赖要求 | 说明 |
| :--- | :--- | :--- |
| 一键脚本（`install.bat` / `install.sh`） | 无需手动安装依赖 | 优先使用 Node.js 18+，缺失时自动复用 Antigravity 内置运行时 |
| 手动 CLI（`check` / `install` / `restore` / `status`） | Node.js >= 18（建议 22.4+） | 零第三方 npm 依赖，无需 `npm install` |
| 免改盘热注入（`live` / `watch`） | **Node.js >= 22.4** | 依赖内置 `WebSocket` 与 CDP 调试端口 |

---

## 手动 CLI 用法

在项目根目录的外部终端中运行：

```bash
# 1. 环境预检（探测 app.asar 路径、补丁状态、CDP 端口与本地进程）
node cli.js check

# 2. ASAR 持久化安装（同时尝试对运行中的窗口热注入）
node cli.js install
# 如需指定非默认位置的 app.asar：
node cli.js install --path "/path/to/resources/app.asar"

# 3. 免改盘热注入 / 后台守护自动重挂（需要 Node.js >= 22.4）
node cli.js live
node cli.js watch
node cli.js stop-watch

# 4. 查看当前安装状态、版本匹配与运行窗口信息
node cli.js status

# 5. 无损还原原始 app.asar
node cli.js restore
```

---

## Antigravity 客户端更新后

Antigravity 客户端自动更新会覆盖替换宿主原有的 `resources/app.asar`。
更新后只需**完全退出 Antigravity 并重新运行一次 [install.bat](./install.bat)（或 `./install.sh`）**即可恢复显示；你的个人设置与历史每日用量账本保存在本地独立目录中，不会随客户端更新丢失。

---

## 常见问题排查（FAQ）

- **安装提示 `app.asar` 被锁定 / `EBUSY` / 被占用**
  Antigravity 进程仍在后台驻留。请右键系统托盘中的 Antigravity 图标彻底退出（或在任务管理器中确认无残留 `Antigravity.exe`），在 `install.bat` 提示处输入 `Y` 回车即可重试。
- **提示权限不足 / `EPERM` / `EACCES`**
  常见于安装在 `C:\Program Files` 等受保护目录的场景。在 `install.bat` 提示处输入 `Y` 允许 UAC 提权，或以管理员身份运行外部终端后重试。
- **双击 `install.bat` 提示找不到 `cli.js` 或闪退**
  通常是因为在压缩包管理器中直接双击运行，请先将整个压缩包解压到本地磁盘目录后再运行。
- **提示找不到 `app.asar`（`Could not auto-detect Antigravity installation`）**
  请通过 `--path "<app.asar 完整路径>"` 参数或环境变量 `AG_ASAR_PATH` 手动指定宿主 `resources/app.asar` 位置。
- **SSH Remote 远端窗口连接报错**
  已原生支持 **SSH Remote** 远端工作区窗口：插件会自动识别远端窗口并复用 Antigravity 的 SSH SOCKS5 隧道与会话鉴权，同时将远端用量合并统计到本地每日用量账本。若网络波动导致短暂报错（如 `ERR_PROXY_CONNECTION_FAILED`），待 Antigravity 的 SSH 自动重连完成后点击刷新图标即可恢复。

---

## 隐私、备份与本地状态目录

本工具所有采集与统计均在**本地闭环运行**，不向任何第三方服务器上报数据。
原始 `app.asar` 备份、校验清单、个人设置与历史每日用量账本均保存在仓库之外的本地状态目录中（可通过 `AG_METER_STATE_DIR` 覆盖）：

- **Windows**：`%LOCALAPPDATA%\AntigravityContextMeter`
- **macOS**：`~/Library/Application Support/AntigravityContextMeter`
- **Linux**：`~/.local/state/AntigravityContextMeter`（或 `$XDG_STATE_HOME/AntigravityContextMeter`）

主要包含文件：
- 原始 `app.asar` 备份及安装清单（供 `restore` / `uninstall` SHA-256 校验无损还原）
- `settings.json`：胶囊展示项与自定义预算配置
- `usage-ledger.json`：跨会话持久化每日用量账本（及外部日志 `external-api-usage.jsonl`）

---

## 开发与测试

- 修改渲染层源码（[src/renderer/](./src/renderer/)）后，运行构建命令更新生成产物 [meter-renderer.js](./meter-renderer.js)：
  ```bash
  npm run build:renderer
  ```
- 运行全量单元测试（`pretest` 会自动先构建渲染层，所有测试均在系统临时隔离目录运行）：
  ```bash
  npm test
  ```
