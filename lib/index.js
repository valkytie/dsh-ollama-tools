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

// settings 命名空間 schema（可呼叫 + 最小 toJSON）。
function dualPeakSchema(value) {
  const v = (value && typeof value === 'object') ? value : {}
  return {
    timezone: (typeof v.timezone === 'string' && v.timezone.trim()) ? v.timezone.trim() : '',
    x: (typeof v.x === 'number' && isFinite(v.x)) ? v.x : 0,
    y: (typeof v.y === 'number' && isFinite(v.y)) ? v.y : 0,
  }
}
dualPeakSchema.toJSON = function () {
  return {
    type: 'object',
    dict: {
      timezone: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
  }
}

// 每月額度（美元）：只有使用者在卡片「設定」填入後才有值，否則為 0（未設定）。
function normalizeAllowance(value) {
  return (typeof value === 'number' && isFinite(value) && value > 0) ? value : UNSET_ALLOWANCE
}

// 金額四捨五入到分：避免 0.141 × 60 = 8.459999999999999 這種浮點尾數流到 API 回應。
function roundMoney(value) {
  return Math.round(value * 100) / 100
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

export const inject = ['webServer', 'settings']

export function apply(ctx) {
  const webServer = ctx.webServer
  const settings = ctx.settings

  try {
    settings.register(NS, dualPeakSchema)
  } catch (e) {
    console.error('[dsh-ollama-tools] settings register failed:', e)
  }
  try {
    settings.register(TOOLS_NS, toolsSchema)
  } catch (e) {
    console.error('[dsh-ollama-tools] tools settings register failed:', e)
  }

  function readConfig() {
    const v = settings.get(NS)
    const obj = (v && typeof v === 'object') ? v : {}
    return {
      timezone: (typeof obj.timezone === 'string' && obj.timezone.trim()) ? obj.timezone.trim() : '',
      x: (typeof obj.x === 'number' && isFinite(obj.x)) ? obj.x : 0,
      y: (typeof obj.y === 'number' && isFinite(obj.y)) ? obj.y : 0,
    }
  }

  function readToolsConfig() {
    const v = settings.get(TOOLS_NS)
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
    await settings.update(NS, patch)
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
    await settings.update(TOOLS_NS, patch)
    return { ok: true, config: readToolsConfig() }
  })

  // 只快取 Ollama 回報的 fraction，額度換算每次即時算（改額度不必等快取過期）。
  let usageCache = null

  registerRoute('/ollama', 'usage', async (args) => {
    const cfg = readToolsConfig()
    const force = !!(args && typeof args === 'object' && args.force === true)
    const ttlMs = cfg.usageCacheMinutes * 60 * 1000
    const now = Date.now()
    let fraction
    let fetchedAt
    let cached = false

    if (!force && usageCache !== null && ttlMs > 0 && now - usageCache.fetchedAt < ttlMs) {
      fraction = usageCache.fraction
      fetchedAt = usageCache.fetchedAt
      cached = true
    } else {
      const apiKey = await resolveOllamaApiKey()
      if (!apiKey) return { ok: false, error: '抓不到（未設定 OLLAMA_API_KEY）' }
      let res
      try {
        res = await fetch(OLLAMA_USAGE_URL, {
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
      const limits = data.limits && data.limits.monthly
      fraction = (limits && typeof limits.usage === 'number') ? limits.usage : null
      fetchedAt = Date.now()
      usageCache = { fraction, fetchedAt }
    }

    const configured = cfg.monthlyAllowance > 0
    return {
      ok: true,
      usage: {
        fraction,
        // 未設定額度時回 null，讓 UI 明確顯示「等待填入」，而不是編一個數字出來。
        allowance: configured ? cfg.monthlyAllowance : null,
        usedDollars: (fraction !== null && configured) ? roundMoney(fraction * cfg.monthlyAllowance) : null,
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
