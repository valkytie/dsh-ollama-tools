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

/** 最小可用的假 ctx：只提供外掛真正用到的 webServer.register 與 settings。
 *
 * 重要：外掛是透過 ctx.get('webServer') / ctx.get('settings') 取服務，不是用
 * ctx.webServer 屬性存取器 —— Cordis 的屬性存取器在服務未就緒時是 undefined，
 * 讀它會炸出 "settings.get is not a function"。這裡兩條路都提供，確保兩種寫法
 * 都能被測到；get() 必須回真服務，否則等於測不到真實路徑。
 */
function makeCtx(settingsService, extra = {}) {
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => routes.set(path, handler) }
  const services = { settings: settingsService, webServer, ...extra }
  const ctx = {
    settings: settingsService,
    webServer,
    logger: { warn: () => {}, error: () => {} },
    inject: () => {},
    get: (name) => services[name],
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

/** 0.2.0 風格（forms 世代）：settings 服務只剩 describe()，值住在 profile entry config，
 *  寫入要走 configEditor.edit(entry, change)。這也是實際 DSH 0.2.0-rc.2 的形狀。 */
function formsService(entryId) {
  const values = {
    timezone: 'Asia/Taipei', billingResetAt: '', x: -3, y: 0,
    monthlyAllowance: 20, usageCacheMinutes: 10,
  }
  const entry = { options: { id: entryId } }
  return {
    settings: {
      describe: () => [{ ns: entryId, value: { ...values }, schema: {}, revision: 1 }],
      // 刻意的：0.2.0 的 settings 沒有公開 update，測試不該假設它有
    },
    configEditor: {
      entries: () => [entry],
      async edit(target, change) {
        if (target !== entry) throw new Error('Configuration entry is no longer available')
        const next = change({ ...values }, {})
        Object.assign(values, next)
      },
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

test('0.2.0 forms：settings 只有 describe()，寫入走 configEditor.edit(entry, change)', async () => {
  const svc = formsService(ENTRY_ID)
  const { ctx, routes } = makeCtx(svc.settings, { configEditor: svc.configEditor })
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true, '讀取必須成功（否則就是使用者看到的 settings.get is not a function）')
  assert.equal(read.config.timezone, 'Asia/Taipei')
  assert.equal(read.config.x, -3)
  assert.equal(read.config.billingResetAt, '')

  const write = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC', billingResetAt: '2026-10-02 11:34' })
  assert.equal(write.ok, true, '寫入必須成功，不可因服務世代而停用')
  assert.equal(write.config.timezone, 'UTC')
  assert.equal(write.config.billingResetAt, '2026-10-02 11:34')

  // 另一個命名空間（額度）寫入時，不可蓋掉已寫入的 timezone
  const write2 = await callRoute(routes, '/ollama/api/setConfig', { monthlyAllowance: 55 })
  assert.equal(write2.ok, true)
  assert.equal(write2.config.monthlyAllowance, 55)
  const back = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(back.config.timezone, 'UTC', '寫入不同欄位時必須合併，不能覆蓋')
  assert.equal(back.config.billingResetAt, '2026-10-02 11:34')
})

test('0.2.0 forms 但取不到 configEditor：讀取仍可用，寫入明確失敗', async () => {
  const svc = formsService(ENTRY_ID)
  const { ctx, routes } = makeCtx(svc.settings)
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true)
  assert.equal(read.config.timezone, 'Asia/Taipei')

  const write = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC' })
  assert.equal(write.ok, false, '不可假成功')
  assert.match(write.error, /configEditor/)
})

test('ctx.settings 屬性存取器是 undefined 時仍可運作（真實 DSH 的 Cordis 行為）', async () => {
  // 回歸：外掛曾用 `const settings = ctx.settings` 取服務，但 Cordis 的 ctx.<service>
  // 是屬性存取器，服務未就緒時是 undefined，於是設定面板整個失效並顯示
  // "settings.get is not a function"。服務只能透過 ctx.get(name) 取。
  const service = legacyService()
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => routes.set(path, handler) }
  const ctx = {
    // getter 模擬未就緒的存取器
    get settings() { return undefined },
    get webServer() { return undefined },
    logger: { warn: () => {}, error: () => {} },
    inject: () => {},
    get: (name) => (name === 'settings' ? service : name === 'webServer' ? webServer : undefined),
    effect: () => {},
  }
  plugin.apply(ctx)

  const read = await callRoute(routes, '/dualpeak/api/getConfig')
  assert.equal(read.ok, true)
  assert.equal(read.config.timezone, 'Asia/Taipei', '必須真的讀到已註冊命名空間的值')

  const write = await callRoute(routes, '/dualpeak/api/setConfig', { timezone: 'UTC' })
  assert.equal(write.ok, true)
  assert.equal(write.config.timezone, 'UTC')
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
