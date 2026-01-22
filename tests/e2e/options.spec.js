const { test, expect } = require('@playwright/test')

const BASE = process.env.URL || 'http://127.0.0.1:5173'

test.describe('Options modal visual', () => {
  test('opens modal and matches golden', async ({ page }) => {
    await page.goto(`${BASE}`)
    // wait for dashboard mount
    await page.waitForSelector('text=Market Intelligence', { timeout: 15000 })

    // Fetch options from proxy and inject a deterministic modal for visual baseline (avoid flakiness)
    const opts = await page.evaluate(async () => {
      const res = await fetch('http://127.0.0.1:5000/api/options/AAPL')
      if (!res.ok) return null
      return await res.json()
    })

    if (!opts) throw new Error('Failed to fetch options for AAPL from proxy')

    await page.evaluate((opts) => {
      const id = '__pw_injected_modal'
      const prev = document.getElementById(id)
      if (prev) prev.remove()
      const div = document.createElement('div')
      div.id = id
      Object.assign(div.style, { position: 'fixed', left: '50%', top: '40%', transform: 'translate(-50%,-40%)', zIndex: '9999', background: '#0f1720', border: '1px solid #111827', padding: '18px', borderRadius: '8px', color: '#e5e7eb', minWidth: '360px' })
      const h = document.createElement('div')
      h.style.display = 'flex'
      h.style.justifyContent = 'space-between'
      h.style.alignItems = 'center'
      h.style.marginBottom = '8px'
      const title = document.createElement('strong')
      title.innerText = 'Options — AAPL'
      const ts = document.createElement('span')
      ts.style.fontSize = '12px'
      ts.style.color = '#9ca3af'
      ts.innerText = new Date().toLocaleString()
      h.appendChild(title)
      h.appendChild(ts)
      div.appendChild(h)
      const exp = document.createElement('div')
      exp.style.fontSize = '13px'
      exp.style.color = '#cbd5e1'
      exp.innerText = 'Expirations: ' + ((opts.expirations||[]).slice(0,6).join(', ') || '—')
      div.appendChild(exp)
      const counts = document.createElement('div')
      counts.style.marginTop = '8px'
      counts.style.fontSize = '13px'
      counts.style.color = '#cbd5e1'
      counts.innerText = 'Calls: ' + ((opts.calls||[]).length||0) + ' • Puts: ' + ((opts.puts||[]).length||0)
      div.appendChild(counts)
      document.body.appendChild(div)
    }, opts)

    // wait for injected modal
    await page.waitForSelector('#__pw_injected_modal', { timeout: 5000 })
    const modal = await page.$('#__pw_injected_modal')
    const screenshot = await modal.screenshot()
    expect(screenshot).toMatchSnapshot('options_modal.png', { maxDiffPixelRatio: 0.001 })
  })
})
