const fetch = require('node-fetch')

const base = process.env.URL || 'http://127.0.0.1:5000'

async function run() {
  try {
    console.log('Checking proxy health...')
    const h = await (await fetch(`${base}/health`)).json()
    console.log('Health:', h)

    console.log('Checking batch for AAPL,MSFT...')
    const b = await (await fetch(`${base}/api/live/batch/AAPL,MSFT`)).json()
    console.log('Batch keys:', Object.keys(b))

    console.log('Checking options AAPL...')
    const o = await (await fetch(`${base}/api/options/AAPL`)).json()
    console.log('Options expirations count:', (o.expirations || []).length)

    console.log('Checking options surface AAPL...')
    const s = await (await fetch(`${base}/api/options/surface/AAPL?n=2`)).json()
    console.log('Surface expirations:', (s.surface || []).length, 'medianIV:', s.medianIV, 'ivPercentile:', s.ivPercentile)

    console.log('IV history:', await (await fetch(`${base}/api/iv/history/AAPL`)).json())
    console.log('All checks done OK')
    process.exit(0)
  } catch (e) {
    console.error('Proxy check failed:', e)
    process.exit(1)
  }
}

run()
