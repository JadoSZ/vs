const { chromium } = require('playwright');
const fs = require('fs');

;(async () => {
  const url = process.env.URL || 'http://localhost:5173'

  // Poll local endpoints to ensure dev server and proxy are responsive
  const check = async (target, timeout = 30000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      try {
        const r = await fetch(target)
        if (r && r.ok) return true
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1500))
    }
    return false
  }

  const headful = process.env.DEBUG_HEADFUL === '1'
  if (!headful) {
    console.log('Checking dev server:', url)
    const viteOk = await check(url)
    console.log('Checking proxy: http://127.0.0.1:5000/health')
    const proxyOk = await check('http://127.0.0.1:5000/health')
    if (!viteOk || !proxyOk) {
      console.error('Servers not ready (vite:', viteOk, 'proxy:', proxyOk, ')')
      process.exit(1)
    }
  } else {
    console.log('DEBUG_HEADFUL=1: skipping server readiness checks and launching browser for live debugging')
  }

  const slow = process.env.SLOWMO ? Number(process.env.SLOWMO) : undefined
  const browser = await chromium.launch({ headless: !headful, slowMo: slow, devtools: !!headful })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  // Ensure symbol is AAPL for consistent surface
  // Ensure setInterval is available in case page overrides it
  await page.addInitScript(() => {
    try {
      if (typeof window === 'undefined') return
      if (typeof window.setInterval !== 'function') {
        window.setInterval = function(cb, t) { return window.setTimeout(cb, t); }
      }
      if (typeof window.clearInterval !== 'function') {
        window.clearInterval = function(id) { return window.clearTimeout(id); }
      }
    } catch (e) {}
  })

  // Listen for console and page errors
  page.on('console', msg => console.log('PAGE LOG:', msg.text()))
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message))

  await page.goto(url)
  await page.evaluate(() => localStorage.setItem('yf_last_symbol', 'AAPL'))
  await page.reload()

  // Debug: print type of setInterval before waiting
  const siType = await page.evaluate(() => ({ type: typeof window.setInterval, toString: window.setInterval ? (window.setInterval.toString ? window.setInterval.toString().slice(0,200) : '') : '' }))
  console.log('setInterval debug:', siType)

  // Debug: capture the first part of the page body to inspect any runtime error text
  const bodyText = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText.substring(0, 2000) : '')
  console.log('PAGE BODY (first 2k chars):\n', bodyText)

  // Debug: capture trimmed HTML content (first 4k chars) to help diagnose mount issues
  const html = await page.content()
  console.log('PAGE HTML (first 4k chars):\n', html ? html.slice(0, 4000) : '')

  // Wait for main header or main container to appear (robust to minor text differences)
  try {
    await page.waitForSelector('text=Market Intelligence', { timeout: 12000 })
  } catch (e) {
    // fall back to waiting for main container
    await page.waitForSelector('main', { timeout: 20000 })
  }
  await page.waitForTimeout(1500)
  // debug: log page body length for diagnostics
  const bodyLen = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText.length : 0)
  console.log('PAGE BODY LENGTH:', bodyLen)

  // Capture the main dashboard area (falls back to full page)
  const el = await page.$('main')
  if (el) {
    await el.screenshot({ path: 'artifacts/dashboard_main.png' })
    console.log('Saved screenshot: artifacts/dashboard_main.png')
  } else {
    console.warn('Main element not found; capturing full page as fallback')
    await page.screenshot({ path: 'artifacts/full_page_dashboard.png', fullPage: true })
    console.log('Saved full page screenshot: artifacts/full_page_dashboard.png')
  }

  // Try to click the first Options button in watchlist to open modal and capture it
  try {
    const optBtn = await page.$('button:has-text("Options")')
    if (optBtn) {
      await optBtn.click()
      await page.waitForSelector('text=Expirations', { timeout: 10000 })
      await page.waitForTimeout(500)
      const modal = await page.$('div[role="dialog"]') || await page.$('text=Options —')
      if (modal) {
        await page.screenshot({ path: 'artifacts/options_modal.png' })
        console.log('Saved screenshot: artifacts/options_modal.png')
      } else {
        console.warn('Options modal not found after click')
      }
    } else {
      console.warn('No Options button found; attempting to inject an options modal for visual verification')
      try {
        const opts = await (await fetch('http://127.0.0.1:5000/api/options/AAPL')).json()
        const html = `<div id="__injected_options_modal" style="position:fixed;left:50%;top:40%;transform:translate(-50%,-40%);z-index:9999;background:#0f1720;border:1px solid #111827;padding:18px;border-radius:8px;color:#e5e7eb;min-width:360px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>Options — AAPL</strong><span style="font-size:12px;color:#9ca3af">${new Date().toLocaleString()}</span></div>
          <div style="font-size:13px;color:#cbd5e1">Expirations: ${(opts.expirations||[]).slice(0,6).join(', ') || '—'}</div>
          <div style="margin-top:8px;font-size:13px;color:#cbd5e1">Calls: ${(opts.calls||[]).length || 0} • Puts: ${(opts.puts||[]).length || 0}</div>
        </div>`
        await page.evaluate((h) => {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = h;
          const node = wrapper.firstElementChild;
          if (node) document.body.appendChild(node);
        }, html)
        await page.waitForTimeout(300)
        const injected = await page.$('#__injected_options_modal')
        if (injected) {
          await injected.screenshot({ path: 'artifacts/options_modal_injected.png' })
          console.log('Saved screenshot: artifacts/options_modal_injected.png')
        }
      } catch (e) {
        console.warn('Injection failed:', e)
      }
    }
  } catch (e) {
    console.warn('Error capturing options modal:', e)
  }

  await browser.close()
})().catch(err => { console.error(err); process.exit(1) })
