// 回歸測試：settings 雙 API 相容層。
//
// DSH 0.1.7 起，settings 服務移除了 `register` / `get` / `installSection`，改成
// 「schema 驅動」：以 profile entry id 定址，用 `describe()` 讀、`update()` 寫，
// 且只有插件 Config 中標了 .volatile() 的欄位會進表單。
// 本插件要同時支援 0.1.5（web profile）與 0.1.7（desktop）兩代，因此做執行期偵測。
//
// 這裡用假的 ctx 與兩種假服務驗證三件事：
//   1) 0.1.5 legacy（register/get）可讀可寫
//   2) 0.1.7 modern（describe/update，以 entry id 定址）可讀可寫
//   3) 兩者皆無時優雅降級：讀到預設值、寫入明確回報失敗（不假成功）
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Windows 上 import() 只吃 file:// URL，直接丟磁碟路徑會 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const ENTRY_ID = 'dsh-ollama-tools'

/** 最小可用的假 ctx：只提供外掛真正用到的 webServer.register 與 settings。 */
function makeCtx(settingsService) {
  const routes = new Map()
  const ctx = {
    settings: settingsService,
    webServer: { register: ({ path, handler }) => routes.set(path, handler) },
    logger: { warn: () => {}, error: () => {} },
    inject: () => {},
    get: () => undefined,
    effect: () => {},
  }
  return { ctx, routes }
}

/** 依路由形狀送出請求並取回 JSON（模擬外掛註冊的 handler）。 */
async function callRoute(routes, path, body) {
  const handler = routes.get(path)
  assert.ok(handler, `找不到路由 ${path}`)
  const req = (async function* () {
    if (body !== undefined) yield JSON.stringify(body)
  })()
  const res = {
    status: 0,
    payload: '',
    writeHead(s) { this.status = s },
    end(b) { this.payload = b },
  }
  await handler(req, res)
  return JSON.parse(res.payload)
}

/** 0.1.5 風格：register 回傳 scope，服務層另有 get/update。 */
function legacyService() {
  const store = {
    'dsbal-dualpeak': { timezone: 'Asia/Taipei', billingResetAt: '', x: -3, y: 0 },
    'dsh-ollama-tools': { monthlyAllowance: 20, usageCacheMinutes: 10 },
  }
  return {
    register(ns) {
      return {
        get: () => store[ns],
        update: (patch) => { store[ns] = { ...store[ns], ...patch } },
        watch: () => () => {},
      }
    },
    get: (ns) => store[ns],
    update: (ns, patch) => { store[ns] = { ...store[ns], ...patch } },
  }
}

/** 0.1.7 風格：以 profile entry id 定址，沒有 register/get。 */
function modernService(entryId) {
  const values = {
    timezone: 'Asia/Taipei', billingResetAt: '', x: -3, y: 0,
    monthlyAllowance: 20, usageCacheMinutes: 10,
  }
  return {
    describe: () => [{ ns: entryId, value: { ...values }, schema: {}, revision: 1 }],
    update(ns, patch) {
      if (ns !== entryId) throw new Error(`No configurable plugin entry "${ns}"`)
      Object.assign(values, patch)
    },
  }
}

test('0.1.5 legacy：可讀取既有設定並寫回', async () => {
  const { ctx, routes } = makeCtx(legacyService())
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true)
  assert.equal(read.config.timezone, 'Asia/Taipei')
  assert.equal(read.config.x, -3)

  const write = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC' })
  assert.equal(write.ok, true)
  assert.equal(write.config.timezone, 'UTC')

  const after = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(after.config.timezone, 'UTC')
})

test('0.1.7 modern：以 entry id 定址，可讀取並寫回', async () => {
  const { ctx, routes } = makeCtx(modernService(ENTRY_ID))
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true)
  assert.equal(read.config.timezone, 'Asia/Taipei')

  const write = await callRoute(routes, '/ollama/api/setConfig', { monthlyAllowance: 55 })
  assert.equal(write.ok, true)
  assert.equal(write.config.monthlyAllowance, 55)

  const back = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC' })
  assert.equal(back.config.timezone, 'UTC')
})

test('兩代皆無時優雅降級：讀預設值，寫入明確失敗', async () => {
  const { ctx, routes } = makeCtx({})
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true, '讀取仍應成功（回預設值）')
  assert.equal(read.config.timezone, '')
  assert.equal(read.config.x, 0)

  const write = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC' })
  assert.equal(write.ok, false, '寫入必須明確失敗，不可靜默假成功')
  assert.match(write.error, /settings/)
})

test('設定值一律經過正規化（不合法輸入不會污染狀態）', async () => {
  const { ctx, routes } = makeCtx(legacyService())
  plugin.apply(ctx)

  const write = await callRoute(routes, '/dualpeak/api/setConfig', {
    timezone: 12345,          // 非字串 → 應落回預設空字串
    x: 'not-a-number',        // 非數字 → 應落回 0
  })
  assert.equal(write.config.timezone, '')
  assert.equal(write.config.x, 0)
})

test('Config 具備 0.1.7 表單所需的欄位與 volatile 標記', () => {
  assert.equal(typeof plugin.Config, 'function', 'Config 必須可呼叫')
  const json = plugin.Config.toJSON()
  assert.ok(json.dict, 'Config.toJSON() 應有 dict')

  const expected = ['timezone', 'billingResetAt', 'x', 'y', 'monthlyAllowance', 'usageCacheMinutes']
  for (const key of expected) {
    assert.ok(json.dict[key], `Config 缺少欄位 ${key}`)
    assert.equal(json.dict[key].meta?.volatile, true, `${key} 必須標記 volatile 才會出現在 0.1.7 表單`)
  }

  // 可呼叫並套用預設值
  const resolved = plugin.Config(undefined)
  assert.equal(resolved.timezone, '')
  assert.equal(resolved.usageCacheMinutes, 10)
})
