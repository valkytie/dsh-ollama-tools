// 回歸測試：峰谷判定必須依兩家官方定價頁的 UTC 定義，
// 不能退回「用顯示時區判斷 + 手動拆跨午夜窗」的舊寫法。
//
// 官方定義（2026-08 起）：
//   DeepSeek：Peak 01:00–04:00、06:00–10:00 UTC，週一至五（= 台北 09:00–12:00 / 14:00–18:00）
//   Ollama  ：Peak 12:00–18:00 UTC，週一至五（= 台北 20:00–24:00 與 週二至週六 00:00–02:00）
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// lib/client.js 是給瀏覽器 ModuleLoader 用的單檔 bundle，沒有可 import 的匯出，
// 因此測試直接從原始碼取出峰谷邏輯區段執行；區段界線若被改動會在這裡直接爆掉，不會靜默失效。
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const start = source.indexOf('const PROVIDERS = [')
const end = source.indexOf('function fmtDuration')
assert.ok(start >= 0 && end > start, 'lib/client.js 找不到峰谷邏輯區段')
const load = new Function(source.slice(start, end) + '\nreturn { PROVIDERS, utcClock, providerState, nextTransition }')
const { PROVIDERS, utcClock, providerState, nextTransition } = load()

const ds = PROVIDERS[0]
const ol = PROVIDERS[1]
/** 以 UTC 建構時刻，測試不依賴執行機器的時區。 */
const utc = (y, m, d, h, mi) => new Date(Date.UTC(y, m - 1, d, h, mi))
const stateAt = (prov, date) => providerState(utcClock(date), prov)
const nextAt = (prov, date) => nextTransition(utcClock(date), prov)

// 2026-09-13 是週日；09-11 週五、09-12 週六、09-14 週一。

test('官方窗定義：DS 01:00–04:00 / 06:00–10:00 UTC、OL 12:00–18:00 UTC（不拆跨午夜）', () => {
  assert.deepEqual(ds.peakRanges, [{ start: 60, end: 240 }, { start: 360, end: 600 }])
  assert.deepEqual(ol.peakRanges, [{ start: 720, end: 1080 }])
})

test('台北週一 00:30（= UTC 週日 16:30）→ Ollama 離峰（修正前誤判尖峰）', () => {
  assert.equal(stateAt(ol, utc(2026, 9, 13, 16, 30)), 'offpeak')
})

test('台北週六 00:30（= UTC 週五 16:30）→ Ollama 尖峰（修正前誤判離峰）', () => {
  assert.equal(stateAt(ol, utc(2026, 9, 11, 16, 30)), 'peak')
})

test('台北週日 22:45 → Ollama 離峰，下一個尖峰 21h15m 後（台北週一 20:00）', () => {
  assert.deepEqual(nextAt(ol, utc(2026, 9, 13, 14, 45)), { minutes: 1275, next: 'peak' })
})

test('台北週五 23:00 → Ollama 尖峰，3h 後轉離峰（跨進 UTC 週五窗尾）', () => {
  assert.deepEqual(nextAt(ol, utc(2026, 9, 11, 15, 0)), { minutes: 180, next: 'offpeak' })
})

test('台北週三 23:00 → Ollama 尖峰，3h 後轉離峰', () => {
  assert.deepEqual(nextAt(ol, utc(2026, 9, 9, 15, 0)), { minutes: 180, next: 'offpeak' })
})

test('台北週一 09:30（= UTC 01:30）→ DeepSeek 尖峰', () => {
  assert.equal(stateAt(ds, utc(2026, 9, 14, 1, 30)), 'peak')
})

test('台北週六 10:00（= UTC 週六 02:00）→ DeepSeek 離峰（落在窗內但 UTC 週末）', () => {
  assert.equal(stateAt(ds, utc(2026, 9, 12, 2, 0)), 'offpeak')
})

test('台北週一 08:00（= UTC 00:00）→ DeepSeek 離峰，1h 後轉尖峰', () => {
  assert.deepEqual(nextAt(ds, utc(2026, 9, 14, 0, 0)), { minutes: 60, next: 'peak' })
})

test('不變式：下一個轉換就是第一次狀態改變（8 天 × 每 7 分鐘 × 兩家）', () => {
  let checked = 0
  for (const prov of PROVIDERS) {
    for (let t = Date.UTC(2026, 8, 7, 0, 0); t < Date.UTC(2026, 8, 15, 0, 0); t += 7 * 60000) {
      const clock = utcClock(new Date(t))
      const cur = providerState(clock, prov)
      const trans = nextTransition(clock, prov)
      assert.notEqual(trans, null)
      assert.notEqual(trans.next, cur)
      assert.equal(providerState(utcClock(new Date(t + (trans.minutes - 1) * 60000)), prov), cur)
      assert.equal(providerState(utcClock(new Date(t + trans.minutes * 60000)), prov), trans.next)
      checked++
    }
  }
  assert.ok(checked > 1000, '掃描樣本數過少')
})
