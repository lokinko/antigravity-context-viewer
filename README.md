# Antigravity Context Meter

专注、轻量的 Antigravity 桌面端上下文、速率、额度与每日用量监控工具，零外部 npm 依赖。

## 核心功能

- **上下文窗口监控**：实时查看当前会话已用 Token、上限预算、剩余空间、占比进度环、分段占比条（缓存读 / 新输入 / 写缓存 / 输出）及压缩回落估算。
- **生成速度与首字延迟**：统计流式输出速度（tok/s）、整体速度、首字延迟（TTFT）、生成耗时与会话平均速度。
- **缓存命中率与账号限额**：在对话栏模型右侧胶囊内紧凑展示 `context`、`decode`、`kv-cache` 以及 `5h` / `weekly` 剩余额度，并在面板中查看详细倒计时。
- **会话与每日用量看板**：统计本对话累计消耗、近 14 天趋势、按模型消耗分布，以及外接 `codex-api` 等外部模型 API 的用量日志汇总。
- **双模式注入**：
  - **ASAR 持久化注入 (`install` / `restore`)**：支持原生 SHA-256 备份校验、原位清洗（兼容旧版卸载与 Antigravity 2.34+ `loadHubWindowUrl`）及 macOS 完整性保护检测。
  - **CDP 免改盘热注入 (`live` / `watch`)**：通过 DevTools 端口实时注入并附带 `live-host` 本地桥接服务，适合免改盘使用或渲染层调试。

## 快速安装（推荐）

> [!IMPORTANT]
> 请勿让 Antigravity 对话框中的 AI 助手自动代装（Antigravity 的安全护栏通常会拒绝修改宿主自身程序文件）。请在**系统外部终端**或直接双击脚本安装，且安装前**完全退出 Antigravity（包括系统托盘图标）**。

### Windows 一键安装 / 卸载

- **安装**：双击 [install.bat](file:///./install.bat)
- **卸载**：双击 [uninstall.bat](file:///./uninstall.bat)

脚本会自动检查解压完整性与运行时依赖：优先使用本机 Node.js（18+），若未单独安装 Node.js 会**自动复用 Antigravity 内置 Node 运行时（零下载安装）**；若检测到文件被锁定或需管理员权限，会按提示引导一键重试或提权。

### macOS / Linux 一键安装 / 卸载

```bash
chmod +x install.sh uninstall.sh
./install.sh     # macOS 若开启 ElectronAsarIntegrity 会引导使用 watch 模式
./uninstall.sh
```

### 手动 CLI 用法

```bash
# 1. 环境预检
node cli.js check

# 2. ASAR 持久化安装（同时尝试对运行中窗口热注入）
node cli.js install

# 3. 免改盘热注入 / 后台守护自动重挂（需要 Node.js >= 22.4）
node cli.js live
node cli.js watch
node cli.js stop-watch

# 4. 查看当前安装与会话状态
node cli.js status

# 5. 无损还原原始 app.asar
node cli.js restore
```

## 开发与测试

```bash
npm run build:renderer
npm test
```
