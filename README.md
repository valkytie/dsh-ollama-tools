# dsh-ollama-tools

DeepSeek Harness (DSH) 插件：**Ollama 工具包**，整合三個 Ollama 相關功能：

1. **雙供應商峰谷對照** — 同時顯示 DeepSeek 官方 API 與 Ollama Cloud 的尖峰/離峰狀態，建議當前最便宜的供應商
2. **Ollama 餘額/用量查詢** — 查詢 Ollama Cloud 本期用量百分比；填入每月額度（美元）後才換算已用金額
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
- 點開顯示兩家狀態、倒數計時、建議供應商（倍率以官方公告為準，卡片不宣稱特定折扣）
- 時區可設定（IANA 名稱，如 `Asia/Taipei`；留空＝本機時間），持久化到 DSH `settings.yaml`
- 可拖曳移動
- 卡片以**實測高度**夾在視窗內（跟隨膠囊位置、視窗縮放即時重算，不會被裁掉）
- 用量區塊顯示資料時間與查詢間隔，配額類資料不需要即時

### 2. Ollama 餘額/用量查詢

卡片內顯示 Ollama Cloud 本期用量百分比（Ollama 回報的真實值）。資料來自 `https://ollama.com/api/usage`，使用 `OLLAMA_API_KEY` 認證。

金額需要你提供「每月額度」才能換算：**未填入額度時只顯示百分比，不會預設任何金額**（Ollama API 的 `activity.cost` 目前對訂閱帳號固定回 `0.00000`，所以無法直接取得實際花費）。

配額變化慢，用量結果預設**快取 10 分鐘**：開卡片不會每次都打 API，卡片會顯示「資料時間」與目前間隔，按「重新整理」則強制重抓一次。

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

### Ollama 用量與額度（選填）

在卡片「設定」填入，或直接編輯 `~/.dsh/settings.yaml`：

```yaml
dsh-ollama-tools:
  monthlyAllowance: 20      # 美元；留空或 0 = 只顯示百分比
  usageCacheMinutes: 10     # 用量快取分鐘數；0 = 每次都查（上限 1440）
```

`monthlyAllowance` 僅用於把百分比換算成金額（`已用 = 百分比 × 額度`）。百分比本身來自 Ollama，永遠是準的。

`usageCacheMinutes` 控制打 Ollama `/api/usage` 的頻率：同一份結果在快取時間內重複使用；額度換算每次即時計算，所以改額度不必等快取過期。

### Ollama API Key

餘額/用量查詢需要 `OLLAMA_API_KEY`。在 DSH 的 Models 頁面設定，或匯出環境變數：

```bash
export OLLAMA_API_KEY=你的key
```

解析順序是**繼承的環境變數 → `.credentials.yaml` → `.env`**：環境變數優先且為唯讀，若它已設定，Models 頁面會無法覆蓋（DSH 會回報 `supplied read-only by the launching environment`）。

## 安全性

自訂路由（`/dualpeak/api/*`、`/ollama/api/*`）掛在 raw webServer 上，會繞過 DSH 給 `/api` 的柵欄，因此插件自己補上同一道檢查：**Host/Origin 信任 + 瀏覽器 session cookie**。未登入、或來源不受信任的本機程式（curl、其他網頁等）一律收到 401／403，既讀不到用量也改不了設定。取不到 `connection` 服務（例如非 web 組合）時維持原行為，不阻擋。

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
