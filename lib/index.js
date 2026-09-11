// dsh-ollama-tools —— Host 半端（靜態 Cordis 插件）
// Ollama 工具包：
//   1) 雙供應商峰谷對照（DeepSeek 官方 API + Ollama Cloud）
//   2) Ollama 餘額/用量查詢（POST /ollama/api/usage）
//   3) 切到 Ollama 模型時，自動在系統提示加入「輸出精簡到 64K 以內」的提醒
//      （真正條件式：只在 provider 為 ollama 時回傳文字，否則空字串被丟棄）

const NS = 'dsbal-dualpeak'
const OLLAMA_USAGE_URL = 'https://ollama.com/api/usage'
const OLLAMA_API_KEY_REF = 'OLLAMA_API_KEY'

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

export const inject = ['webServer', 'settings']

export function apply(ctx) {
  const webServer = ctx.webServer
  const settings = ctx.settings

  try {
    settings.register(NS, dualPeakSchema)
  } catch (e) {
    console.error('[dsh-ollama-tools] settings register failed:', e)
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

  function registerRoute(base, name, handler) {
    webServer.register({
      kind: 'exact',
      path: base + '/api/' + name,
      handler: async (req, res) => {
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

  registerRoute('/ollama', 'usage', async () => {
    const apiKey = await resolveOllamaApiKey()
    if (!apiKey) return { ok: false, error: '未設定 OLLAMA_API_KEY（請在 Models 頁面或環境變數設定）' }
    const res = await fetch(OLLAMA_USAGE_URL, {
      headers: { 'Authorization': 'Bearer ' + apiKey },
    })
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 300) } catch (e) { /* ignore */ }
      return { ok: false, error: 'Ollama API HTTP ' + res.status + (detail ? ': ' + detail : '') }
    }
    const data = await res.json()
    return { ok: true, usage: data }
  })

  // ---- 3) 輸出精簡提醒（真正條件式：只在 provider 為 ollama 時出現）----
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ollama:output-policy',
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 50,
      text: (context) => {
        const provider = context.agent?.options?.provider
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
