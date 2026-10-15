// 回歸測試：Config 必須是「載得起來的」schema。
//
// 2026-10-15 事故：cordis 的 resolveConfig() 會這樣做
//     const result = runtime.Config['~standard'].validate(config)
// 而 profile 的 node_modules 解析不到 schemastery 時，外掛只能走手工 schema；
// 當時手工 schema 沒有 `~standard` 介面 → TypeError: Cannot read properties of
// undefined (reading 'validate') → 整個 plugin tree 載入失敗 → `dsh web` exit 1，
// launchd 就無限 crash loop（runs 衝到三萬多）、3080 完全沒有 listener。
//
// 這個測試鎖住三件事，任何一件壞掉都代表 dsh 可能起不來：
//   1) 有 `~standard.validate`（loader 讀得到，且回傳 { value } 而非 thenable）
//   2) 仍是可呼叫的函式、且 toJSON 還在（0.1.7 форм 世代靠它產生設定表單）
//   3) 未知欄位被剃掉、缺欄位補預設（validate 回傳正規化後的值）
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { Config } = plugin

test('Config 提供 Standard Schema v1 介面（loader 會讀 Config["~standard"].validate）', () => {
  assert.equal(typeof Config, 'function', 'Config 必須可呼叫（legacy 世代直接當函式用）')
  assert.ok(Config['~standard'], '缺少 ~standard：cordis 會 TypeError 讓整個 plugin tree 載入失敗')
  assert.equal(typeof Config['~standard'].validate, 'function', '~standard.validate 必須是函式')
})

test('~standard.validate 是同步的、回傳 { value }，並正規化欄位', () => {
  const result = Config['~standard'].validate({
    timezone: 'Asia/Taipei',
    billingResetAt: '2026-10-08 15:41',
    x: 12,
    y: -3,
    monthlyAllowance: 20,
    usageCacheMinutes: 30,
    unknownField: 'should be dropped',
  })
  assert.ok(!('then' in result), 'validate 不可回傳 thenable（cordis 直接丟 TypeError）')
  assert.equal(result.issues, undefined, '合法輸入不該有 issues')

  assert.equal(result.value.timezone, 'Asia/Taipei')
  assert.equal(result.value.billingResetAt, '2026-10-08 15:41')
  assert.equal(result.value.x, 12)
  assert.equal(result.value.y, -3)
  assert.equal(result.value.monthlyAllowance, 20)
  assert.equal(result.value.usageCacheMinutes, 30)
  assert.ok(!('unknownField' in result.value), '未知欄位應被剃掉')
})

test('缺欄位／型別錯誤時補上安全預設，而不是丟錯', () => {
  const result = Config['~standard'].validate({ timezone: 123, usageCacheMinutes: -5 })
  assert.equal(result.issues, undefined)
  assert.equal(result.value.timezone, '', '非字串 timezone 應退回空字串（＝用本機時間）')
  assert.equal(result.value.x, 0)
  assert.equal(result.value.monthlyAllowance, 0, '未設定的額度是 0，不代表猜測值')
  assert.equal(result.value.usageCacheMinutes, 10, '非法快取分鐘數應退回預設 10')

  const empty = Config['~standard'].validate(undefined)
  assert.equal(empty.issues, undefined)
  assert.equal(empty.value.timezone, '')
})

test('toJSON 仍在（0.1.7+ 表單產生用），且欄位齊全', () => {
  const json = Config.toJSON()
  assert.equal(json.type, 'object')
  for (const key of ['timezone', 'billingResetAt', 'x', 'y', 'monthlyAllowance', 'usageCacheMinutes']) {
    assert.ok(json.dict[key], `toJSON().dict 缺少欄位 ${key}`)
  }
})
