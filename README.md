# dsh-ollama-tools

DeepSeek Harness (DSH) 插件：**Ollama 工具包**，整合三個 Ollama 相關功能：

1. **雙供應商峰谷對照** — 同時顯示 DeepSeek 官方 API 與 Ollama Cloud 的尖峰/離峰狀態，建議當前最便宜的供應商
2. **Ollama 餘額/用量查詢** — 直接查詢 Ollama Cloud 本月用量與各模型 request 數
3. **輸出精簡提醒** — 切到 Ollama 模型時，自動在系統提示加入「輸出精簡到 64K 以內」的提醒（真正條件式，只在 provider 為 ollama 時出現）

## 功能

### 1. 雙供應商峰谷對照

左下角懸浮膠囊同時顯示 **DeepSeek 官方 API** 與 **Ollama Cloud** 兩邊的尖峰/離峰狀態，並直接建議「現在該用哪個供應商」。

DeepSeek-V4 系列自 2026-08-16 起實施峰谷計價，兩家供應商的尖峰時段**剛好互補**（台灣時間）：

| 供應商 | 尖峰時段（週一至五） | 離峰 |
|---|---|---|
| DeepSeek 官方 API | 09:00–12:00、14:00–18:00 | 其餘時間（週末全日） |
| Ollama Cloud | 20:00–02:00(+1) | 其餘時間（週末全日） |

- 膠囊：`DS 峰 · OL 谷` 即時狀態，每 30 秒自動更新
- 點開顯示兩家狀態、倒數計時、價格倍率、建議供應商
- 時區可設定（預設 Asia/Taipei），持久化到 DSH `settings.yaml`
- 可拖曳移動

### 2. Ollama 餘額/用量查詢

卡片內直接顯示 Ollama Cloud 本月用量、成本與各模型 request 數。資料來自 `https://ollama.com/api/usage`，使用 `OLLAMA_API_KEY` 認證。

### 3. 輸出精簡提醒（真正條件式）

當 agent 的 provider 是 `ollama` 時，系統提示會自動加入一段「輸出精簡」政策，提醒模型輸出上限是 65536（64K），要求精簡 reasoning 與工具輸出，避免被截斷。

- **只在 provider 為 ollama 時出現**：透過 system prompt section 的函式文字，依 `context.agent.options.provider` 判斷，非 ollama 時回傳空字串（空 section 自動丟棄）
- 不影響 DeepSeek 官方、qwen 等其他 provider

## 安裝

```bash
dsh plugin --profile web add github:valkytie/dsh-ollama-tools
```

安裝後**重啟 DeepSeek Harness**（`dsh web`）生效。

## 設定

### 峰谷時區

在膠囊「設定」面板改時區，或直接編輯 `~/.dsh/settings.yaml`：

```yaml
dsbal-dualpeak:
  timezone: Asia/Taipei   # 可選，留空 = 本機時間
```

峰谷時段為內建固定值（依 DeepSeek / Ollama 官方公告），不提供修改——若官方調整時段，更新插件即可。

### Ollama API Key

餘額/用量查詢需要 `OLLAMA_API_KEY`。在 DSH 的 Models 頁面設定，或匯出環境變數：

```bash
export OLLAMA_API_KEY=你的key
```

## 卸載

```bash
dsh plugin --profile web rm dsh-ollama-tools
# 重啟 DSH
```

## 目錄結構

```
package.json        # dsh.bundle.patch → cordis.patch.yml；dsh.client → client 半端
cordis.patch.yml    # 插入插件行的 bundle patch
lib/index.js        # Host 半端（設定讀寫 / RPC 路由 / 系統提示 section）
lib/client.js       # Client 半端（懸浮窗 UI）
```

## 授權

MIT
