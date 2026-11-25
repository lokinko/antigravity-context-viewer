# Antigravity Context Meter

专注、轻量的 Antigravity 桌面端上下文监控工具，只保留核心监控能力，零外部依赖。

## 核心功能

- **上下文窗口监控**：实时查看当前会话已用 Token、上限预算、剩余空间、占比进度环、分段占比条（缓存读 / 新输入 / 写缓存 / 输出）及压缩回落估算。
- **生成速度与首字延迟**：统计流式输出速度（tok/s）、整体速度、首字延迟（TTFT）、生成耗时、等待首字实时计时以及会话平均速度。
- **缓存命中率**：展示单次请求与会话加权缓存命中率（`cacheRead / totalInput`）、缓存读取与未缓存输入 Token 及命中请求比。
- **双模式注入**：
  - **ASAR 持久化注入 (`install` / `restore`)**：支持原生 SHA-256 备份校验、原位清洗（兼容旧版卸载与 Antigravity 2.34.0 `loadHubWindowUrl`）及 macOS 完整性保护检测。
  - **CDP 免改盘热注入 (`live` / `watch`)**：通过 DevTools 端口实时注入并附带 `live-host` 本地桥接服务，适合免改盘使用或渲染层调试。

## 快速开始

```bash
# 1. 环境预检
node cli.js check

# 2. ASAR 持久化安装（同时尝试对运行中窗口热注入）
node cli.js install

# 3. 免改盘热注入 / 后台守护自动重挂
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
