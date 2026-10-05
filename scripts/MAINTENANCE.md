# dsh-ollama-tools 維護規則（本機）

## 唯一目標 profile：desktop

**2026-10-05 起，本機只維護 `~/.dsh/profiles/desktop`。**

- `~/.dsh/profiles/web` **已移除**（連同其 cordis.patch.yml / package.json / node_modules）。
  移除原因：兩套 runtime 讓插件同時面對兩種 DSH 世代，且 web 版還被 `npx --yes`
  浮動升級過一次，造成難以定位的故障。
- 對話（`~/.dsh/sessions`，89 個檔）與設定（`~/.dsh/settings.*`）**都保留**，
  它們不在 profile 目錄內，移除 profile 不影響。

## 安裝與更新插件（只對 desktop）

桌面版有自己的 node / pnpm，**不要混用 npm 的版本**：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
$d    = "$env:USERPROFILE\.dsh\profiles\desktop"

& $node $pnpm add "github:valkytie/dsh-ollama-tools#<commit>" --dir $d
```

- 用**明確 commit hash** 釘版，不要用浮動的 `github:valkytie/dsh-ollama-tools`
  （理由同下面「不要浮動升級」）。
- 更新後**必須完全重啟桌面版**（系統匣 → 退出 → 重開）。
  **只關視窗沒用**：host 子進程會沿用舊的記憶體映像，插件看似沒更新。
  驗證方式：`8900` / `19387` 的 OwningProcess 必須是**新的** PID。

## 為什麼不能只靠「檔案已更新」

2026-10-05 的實際事故：磁碟上的插件已是新版、用真實介面測試也正常，
但桌面版卡片仍顯示 `settings.get is not a function` —— 因為**服務中的 host
進程是舊的**。重啟後才恢復。

## DSH 版本不要浮動升級

`npx --yes @deepseek-ai/dsh web` 這種不帶版號的啟動，`npx` 每次都會問 registry
的 `latest` 並在必要時默默升級。2026-10-05 就是這樣在未告知使用者的情況下把
web profile 升到 `0.2.0-rc.2`（該版廢除了 `settings.yaml`、settings 服務改成
`describe` 表單世代），導致插件設定面板失效。

桌面版 App 由 Electron 內建更新管理（`app-update.yml` → nightly 通道），
**版本由使用者決定**，不要用指令幫它升級。

## 插件必須跨世代（能力偵測，不綁版本）

| 世代 | settings 介面 | 值住哪 |
|---|---|---|
| legacy（0.1.5） | `register` + `get` | `settings.yaml` 自訂命名空間 |
| forms（0.1.7 / 0.2.0） | 只有 `describe()`（0.2.0 另有 `configure`） | profile `cordis.patch.yml` 的 entry config；寫入走 `configEditor.edit(entry, change)` |

- 取服務一律用 `ctx.get('name')`，**不要用 `ctx.settings`** —— Cordis 的
  `ctx.<service>` 是屬性存取器，服務未就緒時是 `undefined`。
- 每個世代分支都要有 `typeof x?.method === 'function'` 防護，
  不要讓 `TypeError` 冒到使用者面前。
- runtime 無法辨識時：**只停用設定讀寫並明確回報**，峰谷與用量查詢照常運作。
