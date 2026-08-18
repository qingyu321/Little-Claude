# PRD — 前端热更新签名链

**优先级**: P1 | **状态**: planning | **来源**: 第二轮安全审查（H3）

## 背景

前端热更链路：`latest.json`（清单）+ zip 包同走 raw.githubusercontent / cdn.jsdelivr.net。当前防线：
- ✅ SHA256 校验（防传输篡改）
- ✅ 版本单调性（拒绝降级）
- ✅ zipUrl 主机白名单
- ❌ **清单本身无签名**——清单与哈希同源，渠道写权限被控（jsdelivr/仓库被入侵）即可伪造 latest.json（自带匹配 SHA256）替换整个前端 UI，进而调用全部 IPC

原 tauri-plugin-updater 的签名机制被移除后未补位。热更是唯一能远程替换整个应用 UI 的通道。

## 目标

1. **签名方案**：minisign（ed25519）——发布流程对 zip + latest.json 整体签名；公钥编译进 Rust 二进制
2. **验证点**：`download_web_update` 在 SHA256 校验之外增加签名验证，失败即拒绝应用并保留现场日志
3. **发布侧工具**：`scripts/` 增加签名脚本（私钥不入仓库，走本地密钥文件/环境变量）；publish-release.py 流程集成
4. **降级兜底**：签名验证失败时的用户提示与回退行为（保持当前版本）

## 验收标准

- [ ] 伪造清单（正确 SHA256、无有效签名）被拒绝应用
- [ ] 正常签名包热更流程不受影响（含多源降级路径）
- [ ] 私钥不出现在仓库/构建产物中
- [ ] 验证失败有明确用户可见错误

## 关键文件

`src-tauri/src/commands/web_update.rs`、`src/hooks/useAutoUpdateCheck.ts`、`scripts/publish-release.py`、`scripts/make-web-update.ps1`
