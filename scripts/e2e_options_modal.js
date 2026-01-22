const { chromium } = require('playwright')

;(async () => {
  const baseUrl = process.env.URL || 'http://127.0.0.1:5173'
  // Use query param to instruct the app to open Options modal for AAPL
  const url = `${baseUrl}?openOptions=AAPL`
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  try {
    await page.goto(url)
    await page.evaluate(() => localStorage.setItem('yf_last_symbol', 'AAPL'))
    await page.reload()

    // The app can open the Options modal via ?openOptions=AAPL - wait for modal header
    await page.waitForSelector('text=Expirations', { timeout: 15000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'artifacts/options_modal_e2e.png', fullPage: false })
    console.log('Saved screenshot: artifacts/options_modal_e2e.png')
    await browser.close()
    process.exit(0)
  } catch (e) {
    console.error('E2E failed', e)
    await page.screenshot({ path: 'artifacts/e2e_error.png' })
    await browser.close()
    process.exit(1)
  }
})()
