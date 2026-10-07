// dsh-ollama-tools —— Host 半端（靜態 Cordis 插件）
// Ollama 工具包：
//   1) 雙供應商峰谷對照（DeepSeek 官方 API + Ollama Cloud）
//   2) Ollama 餘額/用量查詢（POST /ollama/api/usage）
//   3) 切到 Ollama 模型時，自動在系統提示加入「輸出精簡到 64K 以內」的提醒
//      （條件式：只在「當前生效」的 provider 為 ollama 時回傳文字，否則空字串被丟棄。
//        判斷來源必須是 session 的即時路由，不能讀 agent.options —— 後者建立後就凍結，
//        使用者在同一個 session 內切走 provider 時不會更新。）

const NS = 'dsbal-dualpeak'
const TOOLS_NS = 'dsh-ollama-tools'
const OLLAMA_USAGE_URL = 'https://ollama.com/api/usage'
const OLLAMA_API_KEY_REF = 'OLLAMA_API_KEY'
// 額度未設定時以 0 表示「使用者還沒填」：不猜測、不換算金額，只顯示 Ollama 回報的百分比。
const UNSET_ALLOWANCE = 0
// 配額不會秒變，預設 10 分鐘內不重複打 Ollama API（可設定 usageCacheMinutes，0 = 每次都抓）。
const DEFAULT_USAGE_CACHE_MINUTES = 10
const MAX_USAGE_CACHE_MINUTES = 1440
const USAGE_TIMEOUT_MS = 8000
// 用量重置錨點（顯示用）：官方計費是每月同一天重置，存一個已知的重置時刻即可；
// 官方 API 沒有這個欄位，只能由使用者填一次。空字串＝未設定。
const MAX_RESET_ANCHOR_LENGTH = 40

function normalizeResetAnchor(value) {
  return (typeof value === 'string') ? value.trim().slice(0, MAX_RESET_ANCHOR_LENGTH) : ''
}

// ---------------------------------------------------------------------------
// Ollama /api/usage 回應解析（2026-10 起的新格式）
//
// 舊格式（已於 2026-10-07 前後下線）：
//   { activity: { cost }, limits: { monthly: { usage: 0.31, models: [...] } } }
//   百分比來自 limits.monthly.usage，金額得靠使用者填的額度換算。
//
// 新格式：
//   { range, scope, granularity, from, until,
//     totals: { request_count, usage_usd, input_tokens, ... },
//     buckets: [ { from, until, request_count, usage_usd, ... }, ... ] }
//   直接給美元金額（usage_usd），buckets 為逐日明細；range 只接受 7d / 30d。
//
// 因此改成：抓 range=30d，用 buckets 依使用者填的重置錨點切出「訂閱週期內」的
// 實際花費，不再需要百分比→金額的換算。
// ---------------------------------------------------------------------------
const OLLAMA_USAGE_RANGE = '30d'

/** 解析單一 bucket 的邊界與金額；形狀不符時回 null。 */
function parseBucket(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const fromMs = Date.parse(raw.from)
  const untilMs = Date.parse(raw.until)
  if (!isFinite(fromMs) || !isFinite(untilMs)) return null
  const usd = (typeof raw.usage_usd === 'number' && isFinite(raw.usage_usd)) ? raw.usage_usd : 0
  const requests = (typeof raw.request_count === 'number' && isFinite(raw.request_count)) ? raw.request_count : 0
  return { fromMs, untilMs, usd, requests }
}

/**
 * 依重置錨點算出「本期」的起訖。
 *
 * 官方計費為每月同一天重置，所以只要知道任何一次重置時刻，就能推出涵蓋 now 的區間：
 * 起點是「≤ now 的最後一次重置」，終點是「> now 的第一次重置」。
 * 錨點無法解析時回 null（呼叫端改用整段 30 天窗口）。
 */
function billingWindow(anchorMs, nowMs) {
  if (typeof anchorMs !== 'number' || !isFinite(anchorMs)) return null
  let start = new Date(anchorMs)
  if (!isFinite(start.getTime())) return null
  let guard = 0
  while (start.getTime() > nowMs && guard < 2400) {
    start = addMonths(start, -1)
    guard++
  }
  while (start.getTime() <= nowMs && guard < 4800) {
    // 先推到「下一次重置」，若仍 ≤ now 就繼續推；停下來時 start 是 ≤ now 的最後一次重置
    const next = addMonths(start, 1)
    if (next.getTime() > nowMs) break
    start = next
    guard++
  }
  if (guard >= 4800) return null
  const end = addMonths(start, 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

// 加減月份：先歸 1 號再加，避免 1/31 + 1 個月溢位成 3/03；目標月天數不足時夾到月底。
function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d
}

/**
 * 從 buckets 加總指定區間的金額與請求數。
 *
 * bucket 是「左閉右開」的日界線，與區間有重疊就整桶計入（日粒度下的合理近似：
 * 誤差僅發生在重置當天，其餘日期完全精確）。
 */
function sumBuckets(buckets, startMs, endMs) {
  let usd = 0
  let requests = 0
  let counted = 0
  for (const b of buckets) {
    if (b.untilMs <= startMs || b.fromMs >= endMs) continue
    usd += b.usd
    requests += b.requests
    counted++
  }
  return { usd: roundMoney(usd), requests, counted }
}

function roundMoney(value) {
  return Math.round(value * 100) / 100
}

// settings 命名空間 schema（可呼叫 + 最小 toJSON）。
function dualPeakSchema(value) {
  const v = (value && typeof value === 'object') ? value : {}
  return {
    timezone: (typeof v.timezone === 'string' && v.timezone.trim()) ? v.timezone.trim() : '',
    billingResetAt: normalizeResetAnchor(v.billingResetAt),
    x: (typeof v.x === 'number' && isFinite(v.x)) ? v.x : 0,
    y: (typeof v.y === 'number' && isFinite(v.y)) ? v.y : 0,
  }
}
dualPeakSchema.toJSON = function () {
  return {
    type: 'object',
    dict: {
      timezone: { type: 'string' },
      billingResetAt: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
  }
}

// 每月額度（美元）：只有使用者在卡片「設定」填入後才有值，否則為 0（未設定）。
function normalizeAllowance(value) {
  return (typeof value === 'number' && isFinite(value) && value > 0) ? value : UNSET_ALLOWANCE
}

// 用量快取分鐘數：0 = 不快取（每次都重新抓），上限 1 天。
function normalizeCacheMinutes(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return DEFAULT_USAGE_CACHE_MINUTES
  return Math.min(Math.floor(value), MAX_USAGE_CACHE_MINUTES)
}

function toolsSchema(value) {
  const v = (value && typeof value === 'object') ? value : {}
  return {
    monthlyAllowance: normalizeAllowance(v.monthlyAllowance),
    usageCacheMinutes: normalizeCacheMinutes(v.usageCacheMinutes),
  }
}
toolsSchema.toJSON = function () {
  return {
    type: 'object',
    dict: {
      monthlyAllowance: { type: 'number' },
      usageCacheMinutes: { type: 'number' },
    },
  }
}

// ---------------------------------------------------------------------------
// Config（DSH 0.1.7+ 的 settings 是 schema 驅動）
//
// 0.1.5：settings.register(ns, schema) 註冊自訂命名空間，表單由該 schema 產生。
// 0.1.7：register/get 被移除，表單改由「插件自己的 Config」產生 —— 只有標了
//        .volatile() 的欄位會出現在設定面板，且以 profile entry id 定址。
//
// 所以宣告一份扁平 Config 把兩個命名空間的欄位合併，讓 0.1.7 能用同一組設定。
// 0.1.5 完全不看這個 Config，行為與原本一致。
//
// 關於 schemastery：只有 runtime 內附的 @deepseek-ai/schemastery（>=3.18.4）
// 有 .volatile()。外掛自己的相依路徑可能解析到沒有該方法的版本，故逐層嘗試，
// 並在最後退回「手工 schema」——形狀與 schemastery 產物相同，讓 loader 仍能
// 讀到欄位（只是不帶 volatile 標記）。全部失敗時 Config 為 undefined，
// 插件其餘功能照常，不會因為 settings 而整個掛掉。
// ---------------------------------------------------------------------------
function buildManualConfig() {
  // 手工 schema：符合 loader 對 Config 的最小期待（可呼叫 + toJSON）。
  // 形狀比照 schemastery 的 toJSON（type/dict），欄位帶 default 與 volatile meta。
  const fields = {
    timezone: { type: 'string', default: '' },
    billingResetAt: { type: 'string', default: '' },
    x: { type: 'number', default: 0 },
    y: { type: 'number', default: 0 },
    monthlyAllowance: { type: 'number', default: UNSET_ALLOWANCE },
    usageCacheMinutes: { type: 'number', default: DEFAULT_USAGE_CACHE_MINUTES },
  }
  const resolve = (value) => {
    const v = (value && typeof value === 'object') ? value : {}
    const out = {}
    for (const [key, spec] of Object.entries(fields)) {
      const raw = v[key]
      if (spec.type === 'number') {
        out[key] = (typeof raw === 'number' && isFinite(raw)) ? raw : spec.default
      } else {
        out[key] = (typeof raw === 'string') ? raw : spec.default
      }
    }
    return out
  }
  const schema = (value) => resolve(value)
  schema.toJSON = () => ({
    type: 'object',
    dict: Object.fromEntries(
      Object.entries(fields).map(([k, s]) => [k, { type: s.type, meta: { default: s.default, volatile: true } }])
    ),
  })
  return schema
}

let Config
try {
  let z
  for (const spec of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      const mod = await import(spec)
      const candidate = mod?.default ?? mod
      if (candidate && typeof candidate.object === 'function') {
        // 只接受真的支援 .volatile() 的版本，否則下面的表單不會出現
        const probe = typeof candidate.string === 'function' ? candidate.string() : null
        if (probe && typeof probe.volatile === 'function') { z = candidate; break }
      }
    } catch (e) { /* 換下一個來源 */ }
  }
  if (z) {
    const v = (schema) => schema.volatile()
    Config = z.object({
      timezone: v(z.string().default('')),
      billingResetAt: v(z.string().default('')),
      x: v(z.number().default(0)),
      y: v(z.number().default(0)),
      monthlyAllowance: v(z.number().default(UNSET_ALLOWANCE)),
      usageCacheMinutes: v(z.number().default(DEFAULT_USAGE_CACHE_MINUTES)),
    })
  } else {
    Config = buildManualConfig()
  }
} catch (e) {
  Config = buildManualConfig()
}
export { Config }

// ---------------------------------------------------------------------------
// settings 適配層（同時支援 DSH 0.1.5 與 0.1.7 兩代 API）
//
// 0.1.5（web profile 舊 runtime）：
//   settings.register(ns, schema)  -> 註冊自訂命名空間
//   settings.get(ns)               -> 讀值
//   settings.update(ns, patch)     -> 寫值
//   ns 是自訂字串（例如 'dsbal-dualpeak'）
//
// 0.1.7（desktop runtime）：register / get / installSection 已被移除，
//   改成「schema 驅動」：
//   ns 必須是 profile entry id（插件在 cordis.patch.yml 的 id）
//   describe() 讀出所有可設定表單，值在 descriptor.value
//   update(entryId, patch) / replace(entryId, section) 寫值
//   且只有 Config schema 裡標了 .volatile() 的欄位能讀寫（一般設定走
//   cordis.patch.yml，不進 settings 表單）。
//
// 因此這裡做「執行期能力偵測」，兩代都能跑；使用者不需選擇。
// 可用 OLLAMA_TOOLS_SETTINGS_API 強制指定 'legacy' | 'modern' 來除錯。
// ---------------------------------------------------------------------------

/** 插件在 profile patch 裡的 entry id —— 0.1.7 用它當命名空間。 */
const ENTRY_ID = 'dsh-ollama-tools'

/**
 * 判斷目前 runtime 的 settings 世代。
 *
 * - legacy（DSH 0.1.5）：settings.register(ns, schema) + settings.get(ns)，
 *   值存在 settings.yaml 的自訂命名空間。
 * - forms（DSH 0.1.7 / 0.2.0）：settings 服務改成「表單投影」——
 *   公開介面只有 describe()（把每個 profile entry 的 Config schema 投影成表單，
 *   值在 descriptor.value），寫入走 configEditor / profile patch；
 *   舊的 settings.yaml 會被 importLegacyDocument() 改名為 .imported 並併進 profile。
 *   0.2.0 的更新方法是內部用的，不在服務介面上，所以判準只看 describe()。
 *
 * 判準刻意以「舊 API 是否齊全」為主：register+get 都在 → legacy；
 * 否則只要有 describe() → forms。兩者皆無才是 none。
 */
function detectSettingsApi(settings) {
  const forced = process.env.OLLAMA_TOOLS_SETTINGS_API
  if (forced === 'legacy' || forced === 'forms' || forced === 'modern') {
    // 'modern' 是 0.1.7 時代的舊名稱，語意同 forms
    return forced === 'modern' ? 'forms' : forced
  }
  const hasLegacy = typeof settings?.register === 'function' && typeof settings?.get === 'function'
  if (hasLegacy) return 'legacy'
  if (typeof settings?.describe === 'function') return 'forms'
  return 'none'
}

// configEditor 只在 forms 世代（0.1.7 / 0.2.0）需要，且是選用的：
// 宣告在這裡會讓 Cordis 等到服務就緒才呼叫 apply；但若某個 runtime 沒有它，
// 插件仍應載入（峰谷與用量查詢不依賴設定寫入），所以不列入 inject，
// 改用 ctx.get('configEditor') 在需要時取，取不到就明確報錯。
export const inject = ['webServer', 'settings']

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  // 注意：不能用 ctx.settings。Cordis 的 ctx.<service> 是「屬性存取器」，服務未就緒
  // 或 inject 尚未解析完時會是 undefined，接著就會炸出 "settings.get is not a function"。
  // ctx.get(name) 才是無條件查詢（同檔的 connection / credentials 也是這樣取）。
  const settings = ctx.get('settings')

  const api = detectSettingsApi(settings)
  if (api === 'none') {
    ctx.logger?.warn?.('[dsh-ollama-tools] settings 服務不支援已知 API，設定功能停用')
  }

  // legacy 專用：註冊得到的 scope（0.1.5 的 register 回傳 scope 時可直接讀寫）
  const scopes = {}

  function registerNamespace(ns, schema) {
    if (api !== 'legacy') return
    try {
      // 0.1.5 的 register 回傳 { get, watch, update, replace }，優先用 scope（
      // 不依賴服務層還有沒有獨立 get）；沒有回傳值時退回服務層方法。
      const scope = settings.register(ns, schema)
      if (scope && typeof scope.get === 'function') scopes[ns] = scope
    } catch (e) {
      console.error('[dsh-ollama-tools] settings register failed (' + ns + '):', e)
    }
  }

  registerNamespace(NS, dualPeakSchema)
  registerNamespace(TOOLS_NS, toolsSchema)

  // forms（0.1.7 / 0.2.0）：值掛在插件自己的 Config 上，從 describe() 找 entry id。
  function formsEntry(ns) {
    try {
      const rows = settings.describe()
      if (!Array.isArray(rows)) return null
      // 以 profile entry id 定址；兼容只認命名空間的版本時再退回 ns。
      return rows.find((r) => r && (r.ns === ENTRY_ID || r.ns === ns)) || null
    } catch (e) {
      return null
    }
  }

  /** 讀一個命名空間的設定值（各世代通用）。 */
  function readNamespace(ns) {
    if (api === 'legacy') {
      const scope = scopes[ns]
      if (scope) return scope.get()
      // 即使偵測到 legacy，實際方法仍可能不存在（服務換代、注入時序）：先確認再呼叫，
      // 不要讓 "settings.get is not a function" 這種 TypeError 冒到使用者面前。
      if (typeof settings?.get !== 'function') return undefined
      try { return settings.get(ns) } catch (e) { return undefined }
    }
    if (api === 'forms') {
      // forms 世代只有一個扁平 entry config（ns = profile entry id），
      // 兩個命名空間的欄位都在裡面，故一律讀同一份值。
      const entry = formsEntry(ns)
      return entry ? entry.value : undefined
    }
    return undefined
  }

  /**
   * 寫一個命名空間的設定（各世代通用）。
   *
   * forms 世代的寫入路徑與 legacy 完全不同：值住在 profile patch 的 entry config，
   * 由 configEditor 管理（settings 服務本身沒有公開的 update）。因此這裡走
   * configEditor 的 patch 寫入；取不到時明確報錯，不假成功。
   */
  async function writeNamespace(ns, patch) {
    if (api === 'legacy') {
      const scope = scopes[ns]
      if (scope && typeof scope.update === 'function') return scope.update(patch)
      if (typeof settings?.update !== 'function') {
        throw new Error('settings 服務不支援寫入（' + ns + '）')
      }
      return settings.update(ns, patch)
    }
    if (api === 'forms') {
      const editor = ctx.get('configEditor')
      if (editor === void 0 || typeof editor.edit !== 'function') {
        throw new Error('settings 為表單世代，但取不到 configEditor.edit，無法寫入（' + ENTRY_ID + '）')
      }
      // 0.2.0 的寫入契約：configEditor.edit(entry, change)
      //   entry  = Loader entry（由 configEditor.entries() 取得，id 為 profile patch id）
      //   change = (current, inherited) => 新的原始 config
      const entry = editor.entries().find((e) => e?.options?.id === ENTRY_ID)
      if (entry === void 0) {
        throw new Error('profile 找不到 entry "' + ENTRY_ID + '"，無法寫入設定')
      }
      const apply = (current) => Object.assign({}, (current && typeof current === 'object') ? current : {}, patch)
      await editor.edit(entry, (current) => apply(current))
      return readNamespace(ns)
    }
    throw new Error('settings 服務不支援已知 API')
  }

  function readConfig() {
    const v = readNamespace(NS)
    const obj = (v && typeof v === 'object') ? v : {}
    return {
      timezone: (typeof obj.timezone === 'string' && obj.timezone.trim()) ? obj.timezone.trim() : '',
      billingResetAt: normalizeResetAnchor(obj.billingResetAt),
      x: (typeof obj.x === 'number' && isFinite(obj.x)) ? obj.x : 0,
      y: (typeof obj.y === 'number' && isFinite(obj.y)) ? obj.y : 0,
    }
  }

  function readToolsConfig() {
    const v = readNamespace(TOOLS_NS)
    const obj = (v && typeof v === 'object') ? v : {}
    return {
      monthlyAllowance: normalizeAllowance(obj.monthlyAllowance),
      usageCacheMinutes: normalizeCacheMinutes(obj.usageCacheMinutes),
    }
  }

  // 自訂路由掛在 raw webServer 上，會繞過 DSH 給 /api 的柵欄；這裡補上同一道檢查
  // （Host/Origin 信任 + 瀏覽器 session cookie），否則任何本機程式都能讀寫設定。
  // 取不到 connection 服務時（例如非 web 組合）維持原行為，不阻擋。
  function rejectUnauthorized(req, res) {
    const connection = ctx.get('connection')
    if (connection === void 0 || typeof connection.requestRejection !== 'function') return false
    const status = connection.requestRejection(req)
    if (status === void 0) return false
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: status === 403 ? '拒絕：來源未受信任' : '拒絕：未登入' }))
    return true
  }

  function registerRoute(base, name, handler) {
    webServer.register({
      kind: 'exact',
      path: base + '/api/' + name,
      handler: async (req, res) => {
        if (rejectUnauthorized(req, res)) return
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (e) { /* ignore stream read error */ }
        let args = null
        try { args = body ? JSON.parse(body) : null } catch (e) { args = null }
        let result
        try {
          result = await handler(args)
        } catch (e) {
          result = { ok: false, error: String((e && e.message) || e).slice(0, 500) }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      },
    })
  }

  // ---- 1) 雙供應商峰谷 ----
  registerRoute('/dualpeak', 'getConfig', async () => {
    return { ok: true, config: readConfig() }
  })

  registerRoute('/dualpeak', 'setConfig', async (args) => {
    const patch = (args && typeof args === 'object' && !Array.isArray(args)) ? args : null
    if (patch === null) return { ok: false, error: '配置無效' }
    try {
      await writeNamespace(NS, patch)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
    }
    return { ok: true, config: readConfig() }
  })

  // ---- 2) Ollama 餘額/用量查詢 ----
  async function resolveOllamaApiKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== void 0) {
      try {
        const hit = await credentials.resolve(OLLAMA_API_KEY_REF)
        if (hit !== void 0 && hit.value && hit.value.length > 0) return hit.value
      } catch (e) { /* fall through to env */ }
    }
    const ambient = process.env[OLLAMA_API_KEY_REF]
    if (ambient && ambient.length > 0) return ambient
    return null
  }

  registerRoute('/ollama', 'setConfig', async (args) => {
    const patch = (args && typeof args === 'object' && !Array.isArray(args)) ? args : null
    if (patch === null) return { ok: false, error: '配置無效' }
    try {
      await writeNamespace(TOOLS_NS, patch)
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
    }
    return { ok: true, config: readToolsConfig() }
  })

  // 只快取 Ollama 回報的 fraction，額度換算每次即時算（改額度不必等快取過期）。
  let usageCache = null

  registerRoute('/ollama', 'usage', async (args) => {
    const cfg = readToolsConfig()
    // 重置錨點存在峰谷命名空間（NS），與額度／快取（TOOLS_NS）不同命名空間。
    // 在 forms 世代兩者其實是同一個扁平 entry config，但仍應各自走 readConfig/readToolsConfig
    // 以免 legacy 世代讀錯地方。
    const peakCfg = readConfig()
    const force = !!(args && typeof args === 'object' && args.force === true)
    const ttlMs = cfg.usageCacheMinutes * 60 * 1000
    const now = Date.now()
    let fetchedAt
    let cached = false

    if (!force && usageCache !== null && ttlMs > 0 && now - usageCache.fetchedAt < ttlMs) {
      fetchedAt = usageCache.fetchedAt
      cached = true
    } else {
      const apiKey = await resolveOllamaApiKey()
      if (!apiKey) return { ok: false, error: '抓不到（未設定 OLLAMA_API_KEY）' }
      let res
      try {
        res = await fetch(OLLAMA_USAGE_URL + '?range=' + OLLAMA_USAGE_RANGE, {
          headers: { 'Authorization': 'Bearer ' + apiKey },
          signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
        })
      } catch (e) {
        return { ok: false, error: '抓不到（Ollama API 無法連線或逾時）' }
      }
      if (!res.ok) return { ok: false, error: '抓不到（Ollama API HTTP ' + res.status + '）' }
      let data
      try {
        data = await res.json()
      } catch (e) {
        return { ok: false, error: '抓不到（Ollama API 回應無法解析）' }
      }

      const buckets = Array.isArray(data.buckets)
        ? data.buckets.map(parseBucket).filter((b) => b !== null)
        : []
      const totalsUsd = (data.totals && typeof data.totals.usage_usd === 'number' && isFinite(data.totals.usage_usd))
        ? data.totals.usage_usd
        : null
      const totalsRequests = (data.totals && typeof data.totals.request_count === 'number' && isFinite(data.totals.request_count))
        ? data.totals.request_count
        : null

      // 新舊格式都認不得 → 明確回報，不讓卡片顯示成「0」誤導使用者
      if (buckets.length === 0 && totalsUsd === null) {
        return { ok: false, error: '抓不到（Ollama API 回應格式非預期，可能已改版）' }
      }

      fetchedAt = Date.now()
      usageCache = {
        fetchedAt,
        buckets,
        totalsUsd,
        totalsRequests,
        rangeFrom: typeof data.from === 'string' ? data.from : null,
        rangeUntil: typeof data.until === 'string' ? data.until : null,
      }
    }

    const snap = usageCache
    const allowance = cfg.monthlyAllowance > 0 ? cfg.monthlyAllowance : null

    // 本期區間：有填重置錨點就精確切出，否則退回整段 API 窗口（30 天）。
    const window = billingWindow(Date.parse(peakCfg.billingResetAt), now)
    let periodUsd = null
    let periodRequests = null
    let periodScope = 'range'
    if (snap.buckets.length > 0) {
      if (window !== null) {
        const sum = sumBuckets(snap.buckets, window.startMs, window.endMs)
        periodUsd = sum.usd
        periodRequests = sum.requests
        periodScope = 'billing'
      } else if (snap.totalsUsd !== null) {
        periodUsd = roundMoney(snap.totalsUsd)
        periodRequests = snap.totalsRequests
      }
    } else if (snap.totalsUsd !== null) {
      periodUsd = roundMoney(snap.totalsUsd)
      periodRequests = snap.totalsRequests
    }

    return {
      ok: true,
      usage: {
        // 新格式直接給金額；百分比改由金額 ÷ 額度算出（額度未填則為 null）。
        usedDollars: periodUsd,
        allowance,
        fraction: (periodUsd !== null && allowance !== null) ? (periodUsd / allowance) : null,
        requests: periodRequests,
        // 這段金額涵蓋的區間：billing = 依重置錨點切出的本期；range = API 的 30 天窗口。
        periodScope,
        periodStart: window !== null ? new Date(window.startMs).toISOString() : snap.rangeFrom,
        periodEnd: window !== null ? new Date(window.endMs).toISOString() : snap.rangeUntil,
        rangeDays: OLLAMA_USAGE_RANGE,
      },
      fetchedAt,
      cached,
      cacheMinutes: cfg.usageCacheMinutes,
    }
  })

  // ---- 3) 輸出精簡提醒（真正條件式：只在 provider 為 ollama 時出現）----
  //
  // 這裡「不能」讀 context.agent.options.provider：agent.options 是 agent 建立時就凍結的，
  // 之後不論是 session 內切換模型（model/selection）還是改預設模型，都不會回寫它。
  // harness 的切換機制（dsh-agent 的 installModelSelection）是在 system-prompt/assemble 之後
  // 覆寫 prompt 變數 provider/model、並在 agent/request 覆寫實際路由；而
  // dsh-system-prompt 的 assemble() 是「先渲染 section 文字，最後才跑該 waterfall」，
  // 所以 section 文字內硬讀 agent.options 只會拿到切換前的舊值（會誤報成 ollama）。
  // 因此改成向 session controller 用的同一個資料源要「當前生效」的 provider。
  function activeProvider(agent) {
    if (agent === void 0) return void 0
    // 1) 已排隊、尚未隨請求送出的選擇（切換後、下一次送出的權威來源）
    try {
      const projections = ctx.get('sessionProjections')
      const state = projections?.stateOf?.(agent.session, 'modelSelection')
      if (state?.pending?.provider) return state.pending.provider
    } catch (e) { /* 服務不存在時往下退 */ }
    // 2) 最近一次實際送出的請求標頭
    try {
      const logged = agent.session?.requestHeader?.()?.config
      if (logged?.provider) return logged.provider
    } catch (e) { /* 同上 */ }
    // 3) 該 session 最後用過的選擇（durable projection）
    try {
      const state = ctx.get('sessionProjections')?.stateOf?.(agent.session, 'modelSelection')
      if (state?.lastUsed?.provider) return state.lastUsed.provider
    } catch (e) { /* 同上 */ }
    // 4) 預設模型，最後才是建立時凍結的 options
    try {
      const def = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (def?.provider) return def.provider
    } catch (e) { /* 同上 */ }
    return agent.options?.provider
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ollama:output-policy',
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 50,
      text: (context) => {
        const provider = activeProvider(context.agent)
        if (provider !== 'ollama') return ''
        return [
          'Output policy (ollama): You are running on the ollama provider, whose output token limit is 65536 (64K).',
          'To avoid being cut off mid-response, keep your output concise:',
          '- Keep reasoning short and to the point.',
          '- Keep tool output and prose tight; do not restate what is already in context.',
          '- Prefer completing the task over verbose explanation.',
        ].join(' ')
      },
    })
  })
}
