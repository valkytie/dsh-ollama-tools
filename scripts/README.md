# 版本 pin 的來由（2026-10-05）

`dsh-restart-web.ps1` 原本用不帶版號的 `npx --yes @deepseek-ai/dsh web` 啟動。
`npx` 每次都會去 registry 問 `latest`，需要時就下載並「默默升級」——**這是一條
未經使用者同意的升級路徑**。

2026-10-05 就是這樣出事的：

| 時間 | 事件 |
|---|---|
| 09:01:16 | 重啟腳本停掉舊 dsh web |
| 09:02:08 | `npx --yes` 抓 `latest` → 下載 `0.2.0-rc.2` |
| 09:02:15 | 安裝完成 |
| 09:02:53 | 新版啟動 |

DSH 0.2.0 改了 `settings` 服務介面（`settings.yaml` 廢除，值改住 profile
`cordis.patch.yml` 的 entry config），於是外掛的 `settings.get` 失效，設定面板
顯示 `settings.get is not a function`。使用者本人的反應是「我根本還沒更新」——
因為他確實沒有：是重啟腳本替他升的。

## 現在的規則

- 啟動一律帶明確版號：`@deepseek-ai/dsh@<version>`。
- 版號寫在腳本內的 `$DshVersion`；可用環境變數 `DSH_VERSION` 臨時覆寫。
- 要升級時**明示**改版號，不要改回浮動 `latest`。

## 為什麼外掛仍要支援多世代

即使 pin 住版本，使用者換機器、換 profile、或主動升級時仍會遇到不同 runtime。
因此外掛以**執行期能力偵測**因應，而不是綁死單一版本：

- `register` + `get` → legacy（0.1.5，值在 `settings.yaml` 自訂命名空間）
- 有 `describe()` → forms（0.1.7 / 0.2.0，值在 profile entry config，寫入走
  `configEditor.edit(entry, change)`）
- 皆無 → 明確停用設定讀寫並回報，峰谷與用量查詢照常運作
