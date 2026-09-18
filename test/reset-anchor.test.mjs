// 回歸測試：用量重置錨點（官方計費＝每月同一天重置，年繳亦同）。
// 官方 API 沒有提供重置時間，因此由使用者填一次錨點，這裡驗推算邏輯。
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const start = source.indexOf('const PROVIDERS = [')
const end = source.indexOf('function fmtDuration')
assert.ok(start >= 0 && end > start, 'lib/client.js 找不到邏輯區段')
const load = new Function(source.slice(start, end) + '\nreturn { nextResetAt, fmtCountdown, resetLabel, addMonths }')
const { nextResetAt, fmtCountdown, resetLabel, addMonths } = load()

/** 本機時間建構（錨點沒帶時區時就是以本機時間解讀）。 */
const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi)

test('錨點在過去 → 推到下一次（每月同一天同時刻）', () => {
  const next = nextResetAt(local(2026, 9, 2, 11, 34).getTime(), local(2026, 9, 18, 0, 0).getTime())
  assert.equal(next.getFullYear(), 2026)
  assert.equal(next.getMonth(), 9) // 10 月
  assert.equal(next.getDate(), 2)
  assert.equal(next.getHours(), 11)
  assert.equal(next.getMinutes(), 34)
})

test('錨點在未來 → 直接回錨點', () => {
  const anchor = local(2026, 10, 2, 11, 34)
  const next = nextResetAt(anchor.getTime(), local(2026, 9, 18, 0, 0).getTime())
  assert.equal(next.getTime(), anchor.getTime())
})

test('月底夾住：1/31 的下一次是 2/28（非閏年）', () => {
  const next = nextResetAt(local(2026, 1, 31, 10, 0).getTime(), local(2026, 2, 1, 0, 0).getTime())
  assert.equal(next.getMonth(), 1) // 2 月
  assert.equal(next.getDate(), 28)
  assert.equal(next.getHours(), 10)
})

test('月底夾住：閏年 1/31 的下一次是 2/29', () => {
  const next = nextResetAt(local(2028, 1, 31, 10, 0).getTime(), local(2028, 2, 1, 0, 0).getTime())
  assert.equal(next.getMonth(), 1)
  assert.equal(next.getDate(), 29)
})

test('加月份不會溢位（1/31 + 1 個月不會變 3/03）', () => {
  const added = addMonths(local(2026, 1, 31, 9, 0), 1)
  assert.equal(added.getMonth(), 1)
  assert.equal(added.getDate(), 28)
})

test('錨點無法解析 → null（卡片顯示「無法解析」而不是亂算）', () => {
  assert.equal(nextResetAt(NaN, Date.now()), null)
  assert.equal(nextResetAt(undefined, Date.now()), null)
  assert.equal(nextResetAt('2026-10-02', Date.now()), null)
  assert.equal(nextResetAt(Infinity, Date.now()), null)
})

test('倒數文字：天/時/分', () => {
  assert.equal(fmtCountdown((13 * 1440 + 12 * 60) * 60000), '13d 12h')
  assert.equal(fmtCountdown((12 * 60 + 30) * 60000), '12h 30m')
  assert.equal(fmtCountdown(45 * 60000), '45m')
  assert.equal(fmtCountdown(0), '0m')
  assert.equal(fmtCountdown(-5000), '0m')
})

test('顯示文字依設定時區換算（UTC 03:34 → 台北 11:34）', () => {
  const at = Date.UTC(2026, 9, 2, 3, 34)
  assert.equal(resetLabel(at, 'Asia/Taipei'), '10/02 11:34')
  assert.equal(resetLabel(at, 'UTC'), '10/02 03:34')
})

test('無效時區 → 退回本機時間且不拋錯', () => {
  const at = local(2026, 10, 2, 11, 34).getTime()
  assert.equal(resetLabel(at, 'Not/AZone'), '10/02 11:34')
  assert.equal(resetLabel(at, ''), '10/02 11:34')
})
