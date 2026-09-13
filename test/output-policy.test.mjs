// 回歸測試：output-policy 章節必須跟著「當前生效」的 provider 走，
// 不能讀 agent.options（那是 agent 建立時凍結的值）。
//
// 對應的真實 bug：在同一個 session 內從 ollama 切到官方 API 後，
// agent.options.provider 仍是 'ollama'，導致系統提示持續夾帶 64K 精簡提醒。
//
// 執行：node --test test/

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

// ---- 最小 host 替身 ----------------------------------------------------------

let currentAgent

function harness({ withProjections = true, defaultProvider = 'deepseek-official' } = {}) {
  const sections = []
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: defaultProvider }) },
  }
  if (withProjections) {
    services.sessionProjections = {
      stateOf: (_session, key) => (key === 'modelSelection' ? currentAgent.projection : undefined),
    }
  }
  apply({
    webServer: { register() {} },
    settings: { register() {}, get: () => ({}), update: async () => {} },
    get: (name) => services[name],
    inject: (_deps, cb) => cb({
      systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 0 },
    }),
  })
  return sections.find((s) => s.name === 'ollama:output-policy').text
}

const selection = (provider) => (provider === undefined ? null : { provider, model: 'test-model' })

function agent({ optionsProvider, pending, lastUsed, header } = {}) {
  return {
    options: optionsProvider === undefined ? {} : { provider: optionsProvider },
    session: {
      requestHeader: () => (header === undefined ? undefined : { config: { provider: header } }),
    },
    projection: { pending: selection(pending), lastUsed: selection(lastUsed) },
  }
}

/** 回傳該 agent 下 output-policy 是否會被注入。 */
function notifies(opts, setup) {
  currentAgent = opts.agent
  const text = harness(setup)
  return text({ agent: currentAgent }).length > 0
}

// ---- 案例 --------------------------------------------------------------------

test('session 內切走 ollama 後不再注入（原本的 bug）', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama', header: 'deepseek-official' }),
  }), false)
})

test('切換後、請求尚未送出時以 pending 為準', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama', pending: 'deepseek-official' }),
  }), false)
})

test('session 內切回 ollama 時仍會注入', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'deepseek-official', pending: 'ollama' }),
  }), true)
})

test('新 session 且預設為 ollama 時會注入（退回 agent.options）', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama' }),
  }, { defaultProvider: 'ollama' }), true)
})

test('預設已改成官方 API 時，殘留的 options=ollama 不注入', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama' }),
  }, { defaultProvider: 'deepseek-official' }), false)
})

test('pending 已消耗且無請求標頭時，退回 lastUsed', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'deepseek-official', lastUsed: 'ollama' }),
  }), true)
})

test('沒有 sessionProjections 服務時仍可運作', () => {
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama' }),
  }, { withProjections: false, defaultProvider: 'ollama' }), true)
  assert.equal(notifies({
    agent: agent({ optionsProvider: 'ollama' }),
  }, { withProjections: false, defaultProvider: 'deepseek-official' }), false)
})
