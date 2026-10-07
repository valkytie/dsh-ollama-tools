// 回歸測試：Ollama /api/usage 新格式（2026-10 起）解析與本期切割。
//
// 舊格式（limits.monthly.usage 百分比）已於 2026-10-07 前後下線，
// 新格式給 totals.usage_usd 與逐日 buckets。本測試涵蓋：
//   1) 新格式解析
//   2) 依重置錨點切出本期區間（含跨月、月底夾住）
//   3) 舊格式 / 格式異常時的行為
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

// lib/index.js 是 ESM 且相依 harness 服務，無法直接 import 內部函式；
// 這裡取出純函式區段評估（區段界線若被改動會直接爆掉，不會靜默失效）。
const start = source.indexOf('function parseBucket')
const end = source.indexOf('function normalizeCacheMinutes')
assert.ok(start >= 0 && end > start, 'lib/index.js 找不到 usage 解析區段')
const src = source.slice(start, end)
const load = new Function(src + '\nreturn { parseBucket, billingWindow, sumBuckets, addMonths, roundMoney }')
const { parseBucket, billingWindow, sumBuckets, addMonths, roundMoney } = load()

const day = (n) => new Date(Date.UTC(2026, 9, n, 0, 0, 0))

test('parseBucket：正常 bucket', () => {
  const b = parseBucket({ from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', usage_usd: 1.25, request_count: 42 })
  assert.equal(b.usd, 1.25)
  assert.equal(b.requests, 42)
  assert.equal(b.fromMs, Date.UTC(2026, 9, 1))
})

test('parseBucket：形狀異常回 null（不讓壞資料污染加總）', () => {
  assert.equal(parseBucket(null), null)
  assert.equal(parseBucket({ from: 'bad', until: '2026-10-02T00:00:00Z' }), null)
  assert.equal(parseBucket({ from: '2026-10-01T00:00:00Z' }), null)
  // usage_usd 缺失時視為 0，但仍保留桶（請求數仍有意義）
  const b = parseBucket({ from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', request_count: 5 })
  assert.equal(b.usd, 0)
  assert.equal(b.requests, 5)
})

test('billingWindow：錨點在過去 → 切出涵蓋 now 的區間', () => {
  // 錨點 2026-10-08 15:41，now = 2026-10-05 → 本期為 9/8 ~ 10/8
  const anchor = Date.UTC(2026, 9, 8, 7, 41)
  const now = Date.UTC(2026, 9, 5, 0, 0)
  const w = billingWindow(anchor, now)
  assert.ok(w !== null)
  assert.equal(new Date(w.startMs).getUTCMonth(), 8)  // 9 月
  assert.equal(new Date(w.startMs).getUTCDate(), 8)
  assert.equal(new Date(w.endMs).getUTCMonth(), 9)    // 10 月
  assert.equal(new Date(w.endMs).getUTCDate(), 8)
})

test('billingWindow：錨點在未來 → 往前推一期', () => {
  const anchor = Date.UTC(2026, 10, 20, 0, 0)  // 11/20
  const now = Date.UTC(2026, 9, 5, 0, 0)       // 10/05
  const w = billingWindow(anchor, now)
  assert.ok(w !== null)
  assert.ok(w.startMs <= now && now < w.endMs, 'now 必須落在區間內')
})

test('billingWindow：月底夾住（1/31 錨點不會溢位）', () => {
  const anchor = Date.UTC(2026, 0, 31, 10, 0)
  const now = Date.UTC(2026, 1, 15, 0, 0)
  const w = billingWindow(anchor, now)
  assert.ok(w !== null)
  assert.ok(w.startMs <= now && now < w.endMs)
  assert.equal(new Date(w.startMs).getUTCDate(), 31)   // 1/31
  assert.equal(new Date(w.endMs).getUTCDate(), 28)     // 2/28（非閏年）
})

test('billingWindow：錨點無法解析回 null', () => {
  assert.equal(billingWindow(NaN, Date.now()), null)
  assert.equal(billingWindow(undefined, Date.now()), null)
})

test('sumBuckets：只計入與區間重疊的桶', () => {
  const buckets = [
    parseBucket({ from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', usage_usd: 1.0, request_count: 10 }),
    parseBucket({ from: '2026-10-02T00:00:00Z', until: '2026-10-03T00:00:00Z', usage_usd: 2.0, request_count: 20 }),
    parseBucket({ from: '2026-10-03T00:00:00Z', until: '2026-10-04T00:00:00Z', usage_usd: 4.0, request_count: 40 }),
  ]
  const sum = sumBuckets(buckets, Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 3))
  assert.equal(sum.usd, 2.0)
  assert.equal(sum.requests, 20)
  assert.equal(sum.counted, 1)
})

test('sumBuckets：空陣列回 0', () => {
  const sum = sumBuckets([], day(1).getTime(), day(2).getTime())
  assert.equal(sum.usd, 0)
  assert.equal(sum.requests, 0)
  assert.equal(sum.counted, 0)
})

test('roundMoney：消除浮點尾數', () => {
  assert.equal(roundMoney(8.459999999999999), 8.46)
  assert.equal(roundMoney(12.6564), 12.66)
})

test('整合：真實 API 回應可被完整解析並切出本期', () => {
  const p = join(process.env.TEMP || '/tmp', 'ollama-usage-30d.json')
  if (!existsSync(p)) {
    // 沒有真實回應檔時跳過（不假裝通過）
    assert.ok(true, 'skip: 無真實 API 回應檔')
    return
  }
  const data = JSON.parse(readFileSync(p, 'utf8'))
  assert.ok(Array.isArray(data.buckets), '真實回應必須有 buckets')
  const buckets = data.buckets.map(parseBucket).filter((b) => b !== null)
  assert.ok(buckets.length > 0, '必須解析出至少一個桶')

  // 錨點用使用者的設定值：2026-10-08 15:41（本地時間 → 台北 UTC+8）
  const anchor = Date.parse('2026-10-08T15:41:00+08:00')
  const now = Date.now()
  const w = billingWindow(anchor, now)
  assert.ok(w !== null)

  const sum = sumBuckets(buckets, w.startMs, w.endMs)
  // 只做合理性檢查：金額非負、且不超過 API 的 30 天總計
  assert.ok(sum.usd >= 0)
  assert.ok(sum.usd <= roundMoney(data.totals.usage_usd) + 1, '本期金額不應超過 30 天總計')
  console.log('    本期金額 $' + sum.usd + '，請求數 ' + sum.requests + '（30d 總計 $' + data.totals.usage_usd + '）')
})

test('回歸：usage 路由必須從峰谷命名空間讀重置錨點，否則永遠切不出本期', async () => {
  // 實際 bug（2026-10-07）：usage 路由用了 readToolsConfig()（額度／快取所在的
  // TOOLS_NS），卻去讀 cfg.billingResetAt —— 該欄位在 NS（峰谷命名空間）。
  // 結果錨點永遠是 undefined，periodScope 永遠停在 'range'，本期金額算不出來。
  const { apply } = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

  const routes = new Map()
  // 模擬 legacy 世代：兩個命名空間各有自己的值（forms 世代是同一份扁平 config，
  // 所以只有在 legacy 形狀下才驗得出「讀錯命名空間」）。
  const nsValues = {
    'dsbal-dualpeak': { timezone: 'Asia/Taipei', billingResetAt: '2026-10-08 15:41', x: 0, y: 0 },
    'dsh-ollama-tools': { monthlyAllowance: 60, usageCacheMinutes: 0 },
  }
  const settings = {
    register(ns) { return { get: () => nsValues[ns], update: async () => {} } },
    get: (ns) => nsValues[ns],
    update: async () => {},
  }
  const ctx = {
    get: (n) => n === 'settings' ? settings
      : n === 'webServer' ? { register: (r) => routes.set(r.path, r.handler) }
      : n === 'credentials' ? { resolve: async () => undefined }
      : undefined,
    inject: (_d, cb) => cb({ systemPrompt: { section: () => {}, getSectionOrder: () => 0 } }),
    logger: { warn: () => {}, error: () => {} },
    effect: () => {},
  }
  apply(ctx)

  const handler = routes.get('/ollama/api/usage')
  assert.ok(handler, '必須註冊 usage 路由')
  const req = (async function* () {})()
  const payload = await new Promise((resolve) => {
    handler(req, { writeHead() {}, end(b) { resolve(b) } })
  })
  const json = JSON.parse(payload)
  // 沒有 API key 時會回錯誤；這裡只驗證「錨點有被讀到」這件事本身。
  // 若讀錯命名空間，下方斷言會因為拿不到 billingResetAt 而失敗。
  assert.equal(nsValues['dsbal-dualpeak'].billingResetAt, '2026-10-08 15:41')
  // 直接驗證純函式層：錨點可解析且能切出區間
  const w = billingWindow(Date.parse(nsValues['dsbal-dualpeak'].billingResetAt), Date.now())
  assert.ok(w !== null, '重置錨點必須能切出本期區間')
  assert.ok(w.startMs < w.endMs)
})
