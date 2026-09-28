# dsh-ollama-tools

DeepSeek Harness (DSH) 插件：**Ollama 工具包**，整合三個 Ollama 相關功能：

1. **雙供應商峰谷對照** — 同時顯示 DeepSeek 官方 API 與 Ollama Cloud 的尖峰/離峰狀態，建議當前最便宜的供應商
2. **Ollama 餘額/用量查詢** — 查詢 Ollama Cloud 本期用量百分比；填入每月額度（美元）後才換算已用金額
3. **輸出精簡提醒** — 切到 Ollama 模型時，自動在系統提示加入「輸出精簡到 64K 以內」的提醒（真正條件式，只在 provider 為 ollama 時出現）

## 功能

### 1. 雙供應商峰谷對照

左下角懸浮膠囊同時顯示 **DeepSeek 官方 API** 與 **Ollama Cloud** 兩邊的尖峰/離峰狀態，並直接建議「現在該用哪個供應商」。

兩家的峰谷時段以**官方定價頁的 UTC 定義**為準（2026-08 起）：

| 供應商 | 官方（UTC，週一至五） | 台北時間 | 離峰 |
|---|---|---|---|
| DeepSeek 官方 API | 01:00–04:00、06:00–10:00 | 09:00–12:00、14:00–18:00（週一至五） | 其餘時間（台北週末全日） |
| Ollama Cloud | 12:00–18:00 | 20:00–24:00（週一至五）＋ 00:00–02:00（週二至週六） | 其餘時間 |

- 膠囊：`DS 峰 · OL 谷` 即時狀態，每 30 秒自動更新
- **判定一律用 UTC**（官方就是以 UTC 定義），所以「顯示時區」設定不影響尖峰/離峰判斷；卡片會把下一個轉換時刻換算成設定時區顯示
- Ollama 的窗在台北會跨午夜：**台北週六 00:00–02:00 仍是尖峰**（UTC 週五窗尾），反之**台北週一 00:00–02:00 是離峰**（UTC 週日）——這兩個邊界是舊版判錯的地方
- 點開顯示兩家狀態、倒數計時、建議供應商（倍率以官方公告為準，卡片不宣稱特定折扣）
- 時區可設定（IANA 名稱，如 `Asia/Taipei`；留空＝本機時間），持久化到 DSH `settings.yaml`
- 可拖曳移動
- 卡片以**實測高度**夾在視窗內（跟隨膠囊位置、視窗縮放即時重算，不會被裁掉）
- 用量區塊顯示資料時間與查詢間隔，配額類資料不需要即時

### 2. Ollama 餘額/用量查詢

卡片內顯示 Ollama Cloud 本期用量百分比（Ollama 回報的真實值）。資料來自 `https://ollama.com/api/usage`，使用 `OLLAMA_API_KEY` 認證。

金額需要你提供「每月額度」才能換算：**未填入額度時只顯示百分比，不會預設任何金額**（Ollama API 的 `activity.cost` 目前對訂閱帳號固定回 `0.00000`，所以無法直接取得實際花費）。

配額變化慢，用量結果預設**快取 10 分鐘**：開卡片不會每次都打 API，卡片會顯示「資料時間」與目前間隔，按「重新整理」則強制重抓一次。

**重置時間**：Ollama 官方 API **沒有**提供計費週期 —— `/api/usage` 只有 `limits.monthly.usage`（`activity.period` 是滾動 4 週，不是訂閱週期），`/api/me` 只有方案名稱；那個精確的重置時間只存在登入後的設定頁 HTML（`data-time`），API key 讀不到。官方計費是「每月同一天重置（年繳亦同）」，因此在卡片「設定」填一次**用量重置時間**（例 `2026-10-02 11:34`），插件就會顯示「用量重置：10/02 11:34（13d 12h 後）」，之後每月自動推算；留空＝不顯示。

### 3. 輸出精簡提醒（真正條件式）

當「當前生效」的 provider 是 `ollama` 時，系統提示會自動加入一段「輸出精簡」政策，提醒模型輸出上限是 65536（64K），要求精簡 reasoning 與工具輸出，避免被截斷。

- **只在 provider 為 ollama 時出現**：透過 system prompt section 的函式文字即時判斷，非 ollama 時回傳空字串（空 section 自動丟棄）
- **判斷來源不能是 `agent.options.provider`**：那是在 agent 建立時就凍結的值，之後在同一個 session 內切換模型（`model/selection`）或改預設模型都不會回寫它。harness 的切換機制是在 `system-prompt/assemble` 之後才覆寫 prompt 變數 `provider` / `model`，而 `dsh-system-prompt` 的 `assemble()` 是「先渲染 section 文字、最後才跑該 waterfall」——因此在 section 文字裡硬讀 `agent.options` 只會拿到切換前的舊值（實際症狀：從 ollama 切到官方 API 後，系統提示仍持續夾帶 64K 提醒）
- 因此改為依序向 session controller 使用的同一批資料源要當前路由：`sessionProjections.modelSelection.pending` → 最近一次送出的 `requestHeader` → `modelSelection.lastUsed` → `agentDefaultModel.currentSelection()` → 最後才退回 `agent.options`
- 不影響 DeepSeek 官方、qwen 等其他 provider

回歸測試：`npm test`（`node --test`），涵蓋切走／切回、pending 尚未送出、只剩 lastUsed、以及沒有 `sessionProjections` 服務時的退路。

峰谷判定另有 `test/peak-valley.test.mjs`：驗官方 UTC 窗、台北跨午夜邊界（週一 00:00–02:00 離峰、週六 00:00–02:00 尖峰），並用 8 天 × 每 7 分鐘的不變式掃描確認「下一個轉換＝第一次狀態改變」。

用量重置則有 `test/reset-anchor.test.mjs`：驗每月推算、月底夾住（1/31 → 2/28、閏年 2/29）、無法解析回 null、以及依時區換算的顯示文字。

settings 相容層則有 `test/settings-compat.test.mjs`：用假的 ctx 分別餵 0.1.5 legacy（`register`/`get`）、0.1.7 modern（`describe`/`update`、以 entry id 定址）與「兩者皆無」三種服務，驗證讀寫與優雅降級，並檢查 `Config` 的 volatile 欄位齊全。

## 支援的 DSH 版本

| DSH | settings API | 狀態 |
|---|---|---|
| `0.1.5`（`dsh web` / web profile） | `register` / `get` / `update` | ✅ 支援 |
| `0.1.7+`（DSH 桌面版 / desktop profile） | `describe` / `update`（schema 驅動） | ✅ 支援 |

DSH `0.1.7` 起 settings 服務移除了 `register` / `get` / `installSection`，改成「schema 驅動」：表單由**插件自己的 `Config`** 產生，只列出標了 `.volatile()` 的欄位，並以 **profile entry id** 定址。

本插件在 `apply()` 時做**執行期能力偵測**，兩代都自動走對的路徑，使用者不需要設定任何東西：

- 有 `register` + `get` → 走 legacy 路徑（維持原有行為）
- 有 `describe` + `update` → 走 modern 路徑（0.1.7）
- 兩者皆無 → 印出警告並停用設定功能；讀取仍回預設值，但**寫入會明確回報失敗**，不會靜默假成功

除錯時可用環境變數強制指定：`OLLAMA_TOOLS_SETTINGS_API=legacy|modern`。

> 注意：`0.1.7` 的路徑需要 `@deepseek-ai/schemastery >= 3.18.4` 才有 `.volatile()`；
> 較舊版本（含 npm 上的 `schemastery@3.18.0`）沒有這個方法。插件會逐層嘗試，
> 最後退回等價的手工 schema（形狀相同、同樣標記 `volatile`），確保表單仍會出現。

## 安裝

### Web 版（`dsh web`）

```bash
dsh plugin --profile web add github:valkytie/dsh-ollama-tools
```

### DSH 桌面版

桌面版使用獨立的 `desktop` profile，且其 runtime 內附在應用程式裡，因此要用桌面版**內建的 pnpm** 安裝：

```powershell
# 1) 用桌面版內建的 pnpm 安裝（Electron 以 Node 模式執行）
$env:DSH_DESKTOP_NODE_EXECUTABLE = "D:\dsh desktop\DeepSeek Harness.exe"
$node = "D:\dsh desktop\DeepSeek Harness.exe"
$pnpm = "D:\dsh desktop\resources\runtime\pnpm\bin\pnpm.mjs"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

& $node $pnpm add --dir $profile github:valkytie/dsh-ollama-tools

# 2) 把套件註冊成 profile bundle（pnpm 只裝相依，不會自動加進 bundles）
#    編輯 $profile\package.json，在 dsh.profile.bundles 陣列加入：
#      "dsh-ollama-tools"
```

安裝後**完全退出並重開 DeepSeek Harness**（不是只關視窗）才會生效。

> 桌面版有自我保護：若第三方外掛導致啟動失敗，它會自動備份 `cordis.patch.yml`
> 並以乾淨設定啟動。手動還原只需把備份檔改名回去。

## 設定

### 顯示時區

在膠囊「設定」面板改時區，或直接編輯 `~/.dsh/settings.yaml`：

```yaml
dsbal-dualpeak:
  timezone: Asia/Taipei   # 可選，留空 = 本機時間
```

這個設定**只影響卡片顯示**（下一個轉換的時刻、時區文字）。峰谷判定固定依官方 UTC 定義，不會因為改了顯示時區而變動。

峰谷時段為內建固定值，來源：

- [Ollama pricing](https://ollama.com/pricing)：*Peak pricing applies between 12:00 and 18:00 UTC, Monday to Friday.*（Peak pricing 只列 deepseek-v4.1-flash / v4-flash / v4-pro 等表列模型）
- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)：*Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday*（off-peak 為尖峰半價）；週末依官方 2026-08-23 公告，全天採離峰價

官方若調整時段，更新插件即可。

### Ollama 用量與額度（選填）

在卡片「設定」填入，或直接編輯 `~/.dsh/settings.yaml`：

```yaml
dsh-ollama-tools:
  monthlyAllowance: 20      # 美元；留空或 0 = 只顯示百分比
  usageCacheMinutes: 10     # 用量快取分鐘數；0 = 每次都查（上限 1440）
```

`monthlyAllowance` 僅用於把百分比換算成金額（`已用 = 百分比 × 額度`）。百分比本身來自 Ollama，永遠是準的。

`usageCacheMinutes` 控制打 Ollama `/api/usage` 的頻率：同一份結果在快取時間內重複使用；額度換算每次即時計算，所以改額度不必等快取過期。

### 用量重置時間（選填）

官方 API 沒有提供重置時間，所以由你填一次。在卡片「設定」輸入，或直接編輯 `~/.dsh/settings.yaml`：

```yaml
dsbal-dualpeak:
  timezone: Asia/Taipei
  billingResetAt: '2026-10-02 11:34'   # 任何一次已知的重置時刻；留空＝不顯示
```

- 只要是**任何一次**已知的重置時刻即可（過去或未來都行），插件以「每月同一天同時刻」推算下一次。
- 未帶時區的字串以**本機時間**解讀；也可寫完整 ISO，例如 `2026-10-02T11:34:00+08:00`。
- 月底會自動夾住（1/31 → 2/28，閏年 → 2/29），不會溢位成 3/03。
- 去哪看這個時間：登入 [ollama.com/settings](https://ollama.com/settings)，把滑鼠移到用量條下方的「Resets in …」上，tooltip 會顯示精確的重置日期時間。

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
