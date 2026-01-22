import React, { useState, useEffect } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Header from './components/Header'
import Watchlist from './components/Watchlist'
import OptionsModal from './components/OptionsModal'
import Alerts from './components/Alerts'
import PortfolioSummary from './components/PortfolioSummary'

// Lightweight, modern, dark-themed dashboard skeleton
// Uses Tailwind CSS for styling and Recharts for charts (placeholders)

export default function App(): JSX.Element {
  const [lastRefresh, setLastRefresh] = useState<string>(() => new Date().toLocaleString())
  const [alertsExpanded, setAlertsExpanded] = useState<boolean>(true)
  const [showAllAlerts, setShowAllAlerts] = useState<boolean>(false)
  const [macroOpen, setMacroOpen] = useState<boolean>(false)
  const [optionsTab, setOptionsTab] = useState<'calls' | 'csps'>('calls')
  const [quantOpen, setQuantOpen] = useState<boolean>(false)
  const [stressOpen, setStressOpen] = useState<boolean>(false)

  // Local yfinance proxy base
  const YFINANCE_PROXY = 'http://127.0.0.1:5000'

  // Watchlist & options data state
  const [watchlist, setWatchlist] = useState<string[]>(['AAPL','MSFT','SPY','TSLA','QQQ'])
  const [watchData, setWatchData] = useState<Record<string, any>>({})
  const [optionsModalOpen, setOptionsModalOpen] = useState<boolean>(false)
  const [optionsModalSymbol, setOptionsModalSymbol] = useState<string | null>(null)
  const [optionsModalData, setOptionsModalData] = useState<any | null>(null)
  const [optionsModalLoading, setOptionsModalLoading] = useState<boolean>(false)
  const [proxyHealthy, setProxyHealthy] = useState<boolean>(true)

  // Simple retry helper
  const retryFetch = async (url: string, tries = 2, delay = 700) => {
    let lastErr: any = null
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return await r.json()
      } catch (e) {
        lastErr = e
        await new Promise(r => setTimeout(r, delay))
      }
    }
    throw lastErr
  }

  // Fetch watchlist data periodically with retries, compute RSI/IV and a simple score
  useEffect(() => {
    let mounted = true
    const computeRSI = (prices: number[]) => {
      if (!prices || prices.length < 15) return null
      const period = 14
      const deltas = []
      for (let i = 1; i < prices.length; i++) deltas.push(prices[i] - prices[i-1])
      let gains = 0, losses = 0
      for (let i = deltas.length - period; i < deltas.length; i++) {
        const d = deltas[i]
        if (d > 0) gains += d
        else losses += Math.abs(d)
      }
      if (gains + losses === 0) return 50
      const rs = (gains / period) / (losses / period || 1)
      const rsi = 100 - (100 / (1 + rs))
      return Math.round(rsi)
    }

    const fetchWL = async () => {
      try {
        const syms = watchlist.join(',')
        const json = await retryFetch(`${YFINANCE_PROXY}/api/live/batch/${encodeURIComponent(syms)}`, 3, 700)
        const data: Record<string, any> = {}
        for (const s of watchlist) {
          const d = json.data?.[s] || null
          const prices = d?.prices || []
          const price = d?.currentPrice ?? (prices.slice(-1)?.[0] ?? null)
          const lastAdj = d?.lastAdjClose ?? null
          const change = (price && lastAdj) ? ((price - lastAdj) / lastAdj * 100) : null
          const rsi = computeRSI(prices)
          // simple SMAs for regime
          const sma = (n:number) => prices.length >= n ? prices.slice(-n).reduce((a,b)=>a+b,0)/n : null
          const sma50 = sma(50)
          const sma200 = sma(200)
          let regime: string | null = null
          if (sma50 && sma200) regime = sma50 > sma200 ? 'BULL' : 'BEAR'
          data[s] = { price, change: change !== null ? Number(change.toFixed(2)) : null, rsi, regime, ivPercentile: null, score: null, nextExpiration: null }
        }

        // fetch options surface for IV metric per symbol (sequential to avoid bursts)
        for (const sym of watchlist) {
          try {
            const j = await retryFetch(`${YFINANCE_PROXY}/api/options/surface/${encodeURIComponent(sym)}?n=2`, 2, 500)
            const surfaces = j.surface || []
            const ivs: number[] = []
            for (const exp of surfaces) {
              for (const st of exp.strikes) {
                if (st.callIV) ivs.push(Number(st.callIV))
                if (st.putIV) ivs.push(Number(st.putIV))
              }
            }
            const medianIV = ivs.length ? ivs.sort((a,b) => a-b)[Math.floor(ivs.length/2)] : null
            if (medianIV != null) {
              data[sym].ivPercentile = Math.round(medianIV * 100)
            }
            if (j.expirations && j.expirations.length) data[sym].nextExpiration = j.expirations[0]
          } catch (e) {
            console.warn('options surface failed for', sym, e)
          }
        }

        // compute simple score: base 50 + change*2 + (50 - rsi)/2 + ivPercentile/4
        for (const s of watchlist) {
          const d = data[s]
          let score = 50
          if (d.change != null) score += Math.min(30, Math.abs(d.change) * 2)
          if (d.rsi != null) score += (50 - d.rsi) / 2
          if (d.ivPercentile != null) score += d.ivPercentile / 4
          d.score = Math.round(Math.max(0, Math.min(100, score)))
        }

        if (mounted) {
          setWatchData(data)
          setProxyHealthy(true)
        }
      } catch (e) {
        console.warn('fetchWatchlist failed', e)
        if (mounted) setProxyHealthy(false)
      }
    }

    fetchWL()
    const id = setInterval(fetchWL, 30 * 1000)
    return () => { mounted = false; clearInterval(id) }
  }, [watchlist])

  // Open options modal and fetch chain
  const openOptionsModal = async (sym: string) => {
    setOptionsModalOpen(true)
    setOptionsModalSymbol(sym)
    setOptionsModalLoading(true)
    setOptionsModalData(null)
    try {
      const j = await retryFetch(`${YFINANCE_PROXY}/api/options/${sym}`, 3, 400)
      setOptionsModalData(j)
    } catch (e) {
      console.warn('openOptionsModal failed', e)
      setOptionsModalData({ error: String(e) })
    } finally {
      setOptionsModalLoading(false)
    }
  }

  // Open modal based on URL query param ?openOptions=SYMBOL for E2E/debug convenience
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const openSym = params.get('openOptions')
      if (openSym && isValidSymbol(openSym)) {
        openOptionsModal(openSym.toUpperCase())
      }
    } catch (e) {}
  }, [])

  // Mock data for charts
  const sparkData = Array.from({length: 20}, (_, i) => ({ x: i, y: 100 + Math.sin(i/2) * 5 + i * 0.2 }))
  const portfolioData = [{name: 'Jan', value: 100}, {name: 'Feb', value: 103}, {name: 'Mar', value: 98}, {name: 'Apr', value: 112}]

  const refresh = () => {
    setLastRefresh(new Date().toLocaleString())
  }

  useEffect(() => {
    const id = setInterval(refresh, 60 * 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="min-h-screen p-6">
      {/* Header */}
        <Header lastRefresh={lastRefresh} onRefresh={() => refresh()} onExport={() => { /* placeholder export */ }} />
      {!proxyHealthy && (
        <div className="my-2 p-3 rounded bg-red-900 text-red-100 border border-red-800 text-sm">Proxy unreachable — the yfinance proxy may be offline or returning errors. Check proxy logs or restart it.</div>
      )}

      {/* Main grid */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left column: Alerts + Watchlist + Macro */}
        <section className="lg:col-span-4 space-y-6">
          {/* Active Alerts */}
          <Alerts expanded={alertsExpanded} onToggle={() => setAlertsExpanded(!alertsExpanded)} showAll={showAllAlerts} onToggleShowAll={() => setShowAllAlerts(!showAllAlerts)} />

          {/* Watchlist Monitor */}
          <Watchlist watchlist={watchlist} watchData={watchData} onOpenOptions={(sym) => openOptionsModal(sym)} />

          {/* Macro Benchmarks */}
          <div className="card">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Macro Benchmarks</h2>
              <button onClick={() => setMacroOpen(!macroOpen)} className="text-sm text-gray-300">{macroOpen ? 'Collapse' : 'Expand'}</button>
            </div>
            {macroOpen ? (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-300">
                {['SPY','QQQ','IWM','TLT','HYG'].map(m => (
                  <div key={m} className="flex items-center justify-between bg-gray-800 p-2 rounded">
                    <div>{m}</div>
                    <div className="text-right">{(100 + Math.random()*20).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 text-sm text-gray-400">Collapsed — click Expand to view benchmark values</div>
            )}
          </div>
        </section>

        {/* Right column: Options & Portfolio */}
        <section className="lg:col-span-8 space-y-6">
          {/* Options Selling Dashboard */}
          <div className="card w-full">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Options Selling Dashboard</h2>
              <div className="flex items-center gap-3">
                <select className="bg-gray-800 border border-gray-800 rounded px-2 py-1 text-sm">
                  <option>2026-01-23</option>
                  <option>2026-02-06</option>
                  <option>2026-02-20</option>
                </select>
                <button className="btn-primary">Suggest Strategic Strike</button>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center gap-3">
                <button onClick={() => setOptionsTab('calls')} className={`px-3 py-1 rounded ${optionsTab==='calls' ? 'bg-purple-700' : 'bg-gray-800'}`}>Calls</button>
                <button onClick={() => setOptionsTab('csps')} className={`px-3 py-1 rounded ${optionsTab==='csps' ? 'bg-purple-700' : 'bg-gray-800'}`}>CSPs</button>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-900 border border-gray-800 p-3 rounded">
                  <div className="text-sm text-gray-400">Strike Table ({optionsTab.toUpperCase()})</div>
                  <div className="mt-2 text-sm text-gray-300">Placeholder for strikes & greeks table (sortable/filterable)</div>
                </div>

                <div className="space-y-3">
                  {[1,2,3].map(i => (
                    <div key={i} className="bg-gray-900 border border-gray-800 p-3 rounded hover:bg-gray-800 transition-all">
                      <div className="flex items-center justify-between"><div className="font-semibold">Position #{i}</div><div className="text-sm text-gray-400">PnL: —</div></div>
                      <div className="text-xs text-gray-400 mt-2">Short: 1x AAPL | Strike: XXX | Bid/Ask spread</div>
                    </div>
                  ))}
                </div>

                <div className="md:col-span-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button className="btn-primary">Save</button>
                    <button className="bg-gray-800 px-3 py-2 rounded hover:bg-gray-800 transition-all">Load</button>
                    <button className="bg-gray-800 px-3 py-2 rounded hover:bg-gray-800 transition-all">Import JSON</button>
                  </div>
                  <div className="text-sm text-gray-400">Total: Positions: 3 • Margin: — • Expected Return: —</div>
                </div>
              </div>
            </div>
          </div>

          {/* Portfolio Summary */}
          <PortfolioSummary sparkData={sparkData} />

          {/* Elite Quant Metrics */}
          <div className="card">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Elite Quant Metrics &amp; 10-Tier Analysis</h3>
              <button onClick={() => setQuantOpen(!quantOpen)} className="text-sm text-gray-300">{quantOpen ? 'Collapse' : 'Expand'}</button>
            </div>
            {quantOpen && (
              <div className="mt-3 text-sm text-gray-300">Placeholder: Quant metrics, ranking, 10-tier risk buckets</div>
            )}
          </div>

          {/* Bottom placeholders: Stress Testing, Drawdown, ML Predictions */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">Stress Testing</h4>
                <button onClick={() => setStressOpen(!stressOpen)} className="text-sm text-gray-300">{stressOpen ? 'Hide' : 'Show'}</button>
              </div>
              {stressOpen && <div className="mt-2 text-sm text-gray-300">Scenario builder & results placeholder</div>}
            </div>

            <div className="card">
              <h4 className="font-semibold">Drawdown Analysis</h4>
              <div className="mt-2 text-sm text-gray-300">Peak-to-trough analysis placeholder</div>
            </div>

            <div className="card">
              <h4 className="font-semibold">ML Predictions &amp; Backtest</h4>
              <div className="mt-2 text-sm text-gray-300">Model predictions &amp; backtest validation placeholder</div>
            </div>
          </div>
        </section>
      </main>

      <OptionsModal open={optionsModalOpen} symbol={optionsModalSymbol} loading={optionsModalLoading} data={optionsModalData} onClose={() => setOptionsModalOpen(false)} onRetry={() => { if (optionsModalSymbol) openOptionsModal(optionsModalSymbol) }} />

    </div>
  )
}
// ============ Legacy / Extended App (moved to LegacyApp) ============
// The original heavy App was retained here but renamed to avoid duplicate default exports.
// Use `LegacyApp` for the legacy dashboard reference if needed.

export function LegacyApp() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dataPoints now include dates for proper x-axis formatting
  const [dataPoints, setDataPoints] = useState<{ date: string; price: number }[]>([])
  const [lastAdjClose, setLastAdjClose] = useState<number | null>(null)
  const [lastDate, setLastDate] = useState<string | null>(null)
  // Fund-grade metrics computed from live data
  const [metrics, setMetrics] = useState<any>(null)

  const SYMBOL_KEY = 'yf_last_symbol'
  const [symbol, setSymbol] = useState<string>(() => {
    try { return (localStorage.getItem(SYMBOL_KEY) || 'AAPL') } catch { return 'AAPL' }
  })
  const [inputSymbol, setInputSymbol] = useState<string>(symbol)

  // Intraday sparkline and IV surface states
  const [intradayTimes, setIntradayTimes] = useState<string[]>([])
  const [intradayPrices, setIntradayPrices] = useState<number[]>([])
  const [intradayLoading, setIntradayLoading] = useState(false)
  const intradayTimerRef = useRef<number | null>(null)
  const [intradayInterval, setIntradayInterval] = useState<string>('1m')

  const [optionsSurface, setOptionsSurface] = useState<any | null>(null)
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [surfaceTooltip, setSurfaceTooltip] = useState<any>(null)
  const [surfaceSelected, setSurfaceSelected] = useState<any | null>(null)
  const [surfaceN, setSurfaceN] = useState<number>(3)
  // WebGL main canvas + overlay (text/tooltips) + minimap
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const miniRef = useRef<HTMLCanvasElement | null>(null)
  const cellRectsRef = useRef<any[]>([])
  const [canvasHeight, setCanvasHeight] = useState<number>(220)
  // Pan/zoom state for heatmap
  const [surfaceZoom, setSurfaceZoom] = useState<number>(1)
  const [surfacePan, setSurfacePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const panRef = useRef({ isPanning: false, startX: 0, startY: 0, origX: 0, origY: 0, lastMoveTime: 0, vx: 0, vy: 0 })
  // Modal drilldown state
  const [modalOpen, setModalOpen] = useState<boolean>(false)
  const [modalLoading, setModalLoading] = useState<boolean>(false)
  const [modalData, setModalData] = useState<any | null>(null)

  const isValidSymbol = (s: string) => /^[A-Z0-9.\-]{1,6}$/.test(s)

  // Debugging: capture global runtime errors & unhandled rejections to show stack in UI
  const [lastError, setLastError] = useState<{ message: string; stack?: string | null } | null>(null)
  useEffect(() => {
    const onErr = (msg: any, src?: any, line?: any, col?: any, err?: any) => {
      const message = (err && err.message) ? err.message : String(msg)
      const stack = (err && err.stack) ? err.stack : (new Error().stack || null)
      console.error('Global error captured', message, err)
      setLastError({ message, stack })
      return false
    }
    const onRej = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason
      const message = reason?.message || String(reason)
      const stack = reason?.stack || null
      console.error('Unhandled rejection captured', reason)
      setLastError({ message, stack })
    }
    window.addEventListener('error', (e: any) => onErr(e.message, e.filename, e.lineno, e.colno, e.error))
    window.addEventListener('unhandledrejection', onRej as any)
    return () => {
      window.removeEventListener('error', (e: any) => onErr(e.message, e.filename, e.lineno, e.colno, e.error))
      window.removeEventListener('unhandledrejection', onRej as any)
    }
  }, [])

  const fetchSymbol = async (sym: string = symbol) => {
    setLoading(true)
    setError(null)
    try {
      // Fetch symbol + SPY + VIX in one batch call to compute beta & VIX correlation
      const batch = `${encodeURIComponent(sym)},SPY,%5EVIX` // %5E = '^' encoded
      const res = await fetch(`${YFINANCE_PROXY}/api/live/batch/${batch}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const json = await res.json()

      const keySym = sym.toUpperCase()
      const symbolData = json.data?.[keySym]
      const spyData = json.data?.['SPY']
      const vixData = json.data?.['^VIX'] || json.data?.['VIX'] || null

      if (!symbolData || symbolData.error) throw new Error(symbolData?.error || `No data for ${sym}`)

      const prices: number[] = symbolData.prices || []
      const dates: string[] = symbolData.dates || []
      setLastAdjClose(symbolData.lastAdjClose ?? null)
      setLastDate(symbolData.lastDate ?? null)

      // Map to {date, price} for date-based x-axis
      const points = dates.map((d: string, i: number) => ({ date: d, price: Number(prices[i]) }))
      setDataPoints(points)

      // --- Analytics ---
      const totalReturn = prices.length > 1 ? ((prices[prices.length - 1] / prices[0] - 1) * 100) : 0
      const annVol = calcAnnVol(prices)
      const sma50 = sma(prices, 50)
      const sma200 = sma(prices, 200)
      const smaSignal = (sma50 && sma200) ? (sma50 > sma200 ? 'GOLDEN' : 'DEATH') : null
      const tech = calculateTechnicals(prices)
      const rsi = tech?.rsi ?? null
      const beta = spyData?.prices ? calcBetaLocal(prices, spyData.prices) : null
      const vixCorr = vixData?.prices ? calcVIXCorrelationLocal(prices, vixData.prices) : null

      // Market state / live price from proxy
      const currentPrice = symbolData.currentPrice ?? null
      const marketState = symbolData.marketState ?? null
      const marketTime = symbolData.marketTime ?? null

      // Additional fund-grade metrics
      const returnsDaily = prices.slice(1).map((p, i) => Math.log(p / prices[i]))
      const sharpe = calcSharpe(returnsDaily)
      const maxDD = calcMaxDrawdown(prices)
      const rollingVolChart = getRollingVolChart(prices, 30)

      // Options snapshot (ATM IV, surface summary) — best-effort
      let impliedMove = null
      let impliedMovePercent = null
      let optionsSnapshot = null
      try {
        optionsSnapshot = await fetchOptionsSnapshot(sym)
        if (optionsSnapshot) {
          impliedMove = optionsSnapshot.impliedMove
          impliedMovePercent = optionsSnapshot.impliedMovePercent
        }
      } catch (e) {
        console.warn('Options snapshot failed', e)
      }

      setMetrics({ totalReturn, annVol, sma50, sma200, smaSignal, rsi, beta, vixCorr, sharpe, maxDD, rollingVolChart, impliedMove, impliedMovePercent, optionsSnapshot, currentPrice, marketState, marketTime })
    } catch (err: any) {
      setError(err?.message || String(err))
      setDataPoints([])
      setLastAdjClose(null)
      setLastDate(null)
      setMetrics(null)
    } finally {
      setLoading(false)
    }
  }

  // Persist symbol and auto-refresh when `symbol` changes
  useEffect(() => {
    try { localStorage.setItem(SYMBOL_KEY, symbol) } catch {}
    fetchSymbol(symbol)
    const id = setInterval(() => fetchSymbol(symbol), 60 * 1000); // refresh every minute

    // Also fetch intraday and options surface once when symbol or interval/expiry count changes
    (async () => {
      setIntradayLoading(true)
      const intr = await fetchIntraday(symbol, intradayInterval)
      if (intr && intr.prices) {
        setIntradayTimes(intr.times || [])
        setIntradayPrices((intr.prices || []).map((p: any) => Number(p)))
      } else {
        setIntradayTimes([])
        setIntradayPrices([])
      }
      setIntradayLoading(false)

      setSurfaceLoading(true)
      const surf = await fetchOptionsSurface(symbol, surfaceN)
      setOptionsSurface(surf)
      setSurfaceLoading(false)
    })()

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, intradayInterval, surfaceN])

  // Auto-refresh intraday every 30s while market is open (REGULAR)
  useEffect(() => {
    if (intradayTimerRef.current) {
      window.clearInterval(intradayTimerRef.current)
      intradayTimerRef.current = null
    }
    if (metrics?.marketState === 'REGULAR') {
      intradayTimerRef.current = window.setInterval(async () => {
        const intr = await fetchIntraday(symbol, intradayInterval)
        if (intr && intr.prices) {
          setIntradayTimes(intr.times || [])
          setIntradayPrices((intr.prices || []).map((p: any) => Number(p)))
        }
      }, 30 * 1000)
    }
    return () => {
      if (intradayTimerRef.current) {
        window.clearInterval(intradayTimerRef.current)
        intradayTimerRef.current = null
      }
    }
  }, [symbol, metrics?.marketState, intradayInterval])

  // WebGL renderer + overlay, pinch/inertia pan and mini-map
  useEffect(() => {
    const glCanvas = glCanvasRef.current
    const overlay = overlayRef.current
    const mini = miniRef.current
    if (!glCanvas || !overlay || !optionsSurface || !optionsSurface.surface) return

    const exps = optionsSurface.surface || []
    if (!exps.length) return

    const strikes = Array.from(new Set(exps.flatMap((e: any) => e.strikes.map((s: any) => s.strike)))).sort((a: number, b: number) => a - b)

    // Setup sizes and DPR
    const rect = glCanvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    glCanvas.width = Math.max(2, Math.floor(rect.width * dpr))
    glCanvas.height = Math.max(2, Math.floor(rect.height * dpr))
    glCanvas.style.width = `${rect.width}px`
    glCanvas.style.height = `${rect.height}px`

    overlay.width = Math.max(2, Math.floor(rect.width * dpr))
    overlay.height = Math.max(2, Math.floor(rect.height * dpr))
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`

    const gl = (glCanvas.getContext('webgl2') || glCanvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) {
      console.warn('WebGL not available, falling back to 2D canvas')
      // Fallback: clear and return (existing 2D code still exists as reference)
      const ctx = glCanvas.getContext('2d') as CanvasRenderingContext2D
      if (ctx) ctx.clearRect(0, 0, rect.width, rect.height)
      return
    }

    // Use scissor-based rectangle fills (simple, high-performance)
    gl.viewport(0, 0, glCanvas.width, glCanvas.height)
    gl.disable(gl.DEPTH_TEST)

    // Helper to convert color string 'rgb(r,g,b)' to floats
    const rgbToFloats = (rgb: string) => {
      const m = rgb.match(/\d+/g) || ['245','245','245']
      return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255, 1]
    }

    // Draw cells with scissor rectangles
    const cols = strikes.length
    const rows = exps.length
    const widthPx = rect.width
    const heightPx = rect.height
    const cellW = (widthPx * surfaceZoom) / Math.max(1, cols)
    const cellH = (heightPx * surfaceZoom) / Math.max(1, rows)
    const offsetX = surfacePan.x
    const offsetY = surfacePan.y

    // Clear
    gl.clearColor(1,1,1,1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const cellRects: any[] = []

    for (let r = 0; r < rows; r++) {
      const exp = exps[r]
      for (let c = 0; c < cols; c++) {
        const strike = strikes[c]
        const strikeObj = exp.strikes.find((st: any) => st.strike === strike) || {}
        const ivCall = strikeObj.callIV != null ? strikeObj.callIV * 100 : null
        const ivPut = strikeObj.putIV != null ? strikeObj.putIV * 100 : null
        const ivAvg = (ivCall !== null && ivPut !== null) ? ((ivCall + ivPut) / 2) : (ivCall ?? ivPut ?? null)
        const x = Math.round(offsetX + c * cellW)
        const y = Math.round(offsetY + r * cellH)
        if (x + cellW < 0 || y + cellH < 0 || x > widthPx || y > heightPx) continue
        const color = rgbToFloats(getIVColor(ivAvg))
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(Math.round(x * dpr), Math.round(y * dpr), Math.max(1, Math.round(cellW * dpr)), Math.max(1, Math.round(cellH * dpr)))
        gl.clearColor(color[0], color[1], color[2], 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.SCISSOR_TEST)

        // Add for hit testing on overlay coordinate space
        cellRects.push({ x, y, w: cellW, h: cellH, expiration: exp.expiration, strike, callIV: ivCall, putIV: ivPut, callLast: strikeObj.callLast, putLast: strikeObj.putLast })
      }
    }

    cellRectsRef.current = cellRects

    // Draw overlay labels (2D canvas) for visible cells
    const ctx = overlay.getContext('2d') as CanvasRenderingContext2D
    if (ctx) {
      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '11px sans-serif'
      ctx.fillStyle = '#111'
      cellRects.forEach(cell => {
        const text = cell.callIV !== null || cell.putIV !== null ? `${Math.round((cell.callIV ?? cell.putIV) || 0)}%` : '—'
        ctx.fillStyle = cell.callIV !== null || cell.putIV !== null ? '#111' : '#666'
        ctx.fillText(text, cell.x + cell.w / 2, cell.y + cell.h / 2)
      })
      ctx.restore()
    }

    // Mini-map rendering
    if (mini) {
      const mrect = mini.getBoundingClientRect()
      const mdpr = dpr
      mini.width = Math.max(2, Math.floor(mrect.width * mdpr))
      mini.height = Math.max(2, Math.floor(mrect.height * mdpr))
      mini.style.width = `${mrect.width}px`
      mini.style.height = `${mrect.height}px`
      const mctx = mini.getContext('2d') as CanvasRenderingContext2D
      if (mctx) {
        mctx.save()
        mctx.scale(mdpr, mdpr)
        mctx.clearRect(0,0,mrect.width,mrect.height)
        const sx = mrect.width / Math.max(1, cols)
        const sy = mrect.height / Math.max(1, rows)
        for (let r = 0; r < rows; r++) {
          const exp = exps[r]
          for (let c = 0; c < cols; c++) {
            const strike = strikes[c]
            const strikeObj = exp.strikes.find((st: any) => st.strike === strike) || {}
            const ivCall = strikeObj.callIV != null ? strikeObj.callIV * 100 : null
            const ivPut = strikeObj.putIV != null ? strikeObj.putIV * 100 : null
            const ivAvg = (ivCall !== null && ivPut !== null) ? ((ivCall + ivPut) / 2) : (ivCall ?? ivPut ?? null)
            mctx.fillStyle = getIVColor(ivAvg)
            mctx.fillRect(c * sx, r * sy, Math.max(1, sx), Math.max(1, sy))
          }
        }
        // Draw viewport rect
        const vx = (-offsetX) / (cols * cellW) * mrect.width
        const vy = (-offsetY) / (rows * cellH) * mrect.height
        const vw = (rect.width / (cols * cellW)) * mrect.width
        const vh = (rect.height / (rows * cellH)) * mrect.height
        mctx.strokeStyle = '#000'
        mctx.lineWidth = 1
        mctx.strokeRect(vx, vy, Math.max(4, vw), Math.max(4, vh))
        mctx.restore()
      }
    }

    // Pointer/touch handlers (attach to overlay)
    let lastTouchDist = null
    const overlayBr = overlay.getBoundingClientRect()

    const onMove = (ev: PointerEvent) => {
      const x = ev.clientX - overlayBr.left
      const y = ev.clientY - overlayBr.top
      if (panRef.current.isPanning) {
        const dx = ev.clientX - panRef.current.startX
        const dy = ev.clientY - panRef.current.startY
        const now = performance.now()
        const dt = Math.max(1, now - panRef.current.lastMoveTime)
        panRef.current.lastMoveTime = now
        panRef.current.vx = dx / dt
        panRef.current.vy = dy / dt
        setSurfacePan({ x: panRef.current.origX + dx, y: panRef.current.origY + dy })
        return
      }
      const found = cellRects.find(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)
      if (found) setSurfaceTooltip({ x: ev.clientX, y: ev.clientY, expiration: found.expiration, strike: found.strike, callIV: found.callIV, putIV: found.putIV })
      else setSurfaceTooltip(null)
    }

    const onDown = (ev: PointerEvent) => {
      if (ev.button === 1 || ev.altKey) {
        panRef.current.isPanning = true
        panRef.current.startX = ev.clientX
        panRef.current.startY = ev.clientY
        panRef.current.origX = surfacePan.x
        panRef.current.origY = surfacePan.y
        panRef.current.lastMoveTime = performance.now()
        try { (overlay as HTMLCanvasElement).setPointerCapture(ev.pointerId) } catch {}
        return
      }
      const x = ev.clientX - overlayBr.left
      const y = ev.clientY - overlayBr.top
      const found = cellRects.find(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)
      if (found) {
        setSurfaceSelected({ expiration: found.expiration, strike: found.strike, callIV: found.callIV, putIV: found.putIV, callLast: found.callLast, putLast: found.putLast })
        ;(async () => {
          setModalLoading(true); setModalOpen(true)
          try {
            const chain = await fetchOptionsChain(symbol, found.expiration)
            if (chain) {
              const calls = (chain.calls || []).filter((c: any) => Number(c.strike) === Number(found.strike))
              const puts = (chain.puts || []).filter((p: any) => Number(p.strike) === Number(found.strike))
              setModalData({ calls, puts, strike: found.strike, expiration: found.expiration })
            } else setModalData(null)
          } catch (e) { setModalData(null); console.warn('Modal fetch failed', e) }
          setModalLoading(false)
        })()
      }
    }

    const onUp = (ev: PointerEvent) => {
      if (panRef.current.isPanning) {
        panRef.current.isPanning = false
        try { (overlay as HTMLCanvasElement).releasePointerCapture(ev.pointerId) } catch {}
        // inertia
        let vx = panRef.current.vx || 0
        let vy = panRef.current.vy || 0
        let rafId: number | null = null
        const decel = 0.95
        const step = () => {
          vx *= decel; vy *= decel
          setSurfacePan(p => ({ x: p.x + vx * 16, y: p.y + vy * 16 }))
          if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01) rafId = requestAnimationFrame(step)
        }
        step()
      }
    }

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const mx = ev.clientX - overlayBr.left
      const my = ev.clientY - overlayBr.top
      const prev = surfaceZoom
      const factor = Math.exp(-ev.deltaY * 0.001)
      const newZoom = Math.max(0.4, Math.min(6, prev * factor))
      const panX = mx - (mx - surfacePan.x) * (newZoom / prev)
      const panY = my - (my - surfacePan.y) * (newZoom / prev)
      setSurfaceZoom(newZoom)
      setSurfacePan({ x: panX, y: panY })
    }

    // Touch pinch handlers
    let pinchStartDist: number | null = null
    let pinchStartZoom = surfaceZoom
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length === 2) {
        const t0 = ev.touches[0]; const t1 = ev.touches[1]
        pinchStartDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY)
        pinchStartZoom = surfaceZoom
      }
    }
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length === 2 && pinchStartDist) {
        const t0 = ev.touches[0]; const t1 = ev.touches[1]
        const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY)
        const factor = dist / pinchStartDist
        const newZoom = Math.max(0.4, Math.min(6, pinchStartZoom * factor))
        setSurfaceZoom(newZoom)
      }
    }

    overlay.style.cursor = 'crosshair'
    overlay.addEventListener('pointermove', onMove)
    overlay.addEventListener('pointerdown', onDown)
    overlay.addEventListener('pointerup', onUp)
    overlay.addEventListener('wheel', onWheel, { passive: false })
    overlay.addEventListener('touchstart', onTouchStart, { passive: true })
    overlay.addEventListener('touchmove', onTouchMove, { passive: true })
    overlay.addEventListener('contextmenu', (e) => e.preventDefault())

    // Mini-map click to recenter
    const onMiniClick = (ev: MouseEvent) => {
      if (!mini) return
      const mrect = mini.getBoundingClientRect()
      const x = ev.clientX - mrect.left
      const y = ev.clientY - mrect.top
      const cols = strikes.length; const rows = exps.length
      const sx = mrect.width / Math.max(1, cols)
      const sy = mrect.height / Math.max(1, rows)
      const col = Math.floor(x / sx); const row = Math.floor(y / sy)
      const centerX = -(col * cellW - rect.width / 2)
      const centerY = -(row * cellH - rect.height / 2)
      setSurfacePan({ x: centerX, y: centerY })
    }
    mini?.addEventListener('click', onMiniClick)

    // Resize
    const ro = new ResizeObserver(() => setTimeout(() => setCanvasHeight(h => Math.max(120, h)), 60))
    ro.observe(glCanvas)

    return () => {
      overlay.removeEventListener('pointermove', onMove)
      overlay.removeEventListener('pointerdown', onDown)
      overlay.removeEventListener('pointerup', onUp)
      overlay.removeEventListener('wheel', onWheel)
      overlay.removeEventListener('touchstart', onTouchStart)
      overlay.removeEventListener('touchmove', onTouchMove)
      overlay.removeEventListener('contextmenu', (e) => e.preventDefault())
      mini?.removeEventListener('click', onMiniClick)
      if (ro) ro.disconnect()
      setSurfaceTooltip(null)
    }
  }, [optionsSurface, canvasHeight, surfaceZoom, surfacePan])

  return (
    <div style={{ padding: 20 }}>
      <h1>YFinance Live Dashboard ({symbol})</h1>
      <p>
        Make sure the Python proxy is running on <code>http://127.0.0.1:5000</code>. If you see connection
        errors using "localhost", try replacing it with <code>127.0.0.1</code> in your settings.
      </p>

      {/* DEBUG OVERLAY showing global runtime error for easier remote diagnosis */}
      {lastError && (
        <div style={{ position: 'fixed', right: 12, top: 12, zIndex: 99999, background: '#fff8f8', color: '#B71C1C', border: '2px solid #FFCDD2', padding: 12, maxWidth: 520, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Runtime Error: {lastError.message}</div>
          <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>{lastError.stack}</pre>
        </div>
      )}


      <div style={{ margin: '1rem 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          aria-label="Symbol"
          type="text"
          value={inputSymbol}
          onChange={(e) => setInputSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const s = inputSymbol.trim().toUpperCase()
              if (!isValidSymbol(s)) { setError('Invalid symbol (A-Z, 0-9, ., - up to 6 chars)'); return }
              setError(null)
              setSymbol(s)
            }
          }}
          style={{ padding: '6px 8px', width: 120 }}
        />
        <button
          onClick={() => {
            const s = inputSymbol.trim().toUpperCase()
            if (!isValidSymbol(s)) { setError('Invalid symbol (A-Z, 0-9, ., - up to 6 chars)'); return }
            setError(null)
            setSymbol(s)
          }}
          disabled={loading || !isValidSymbol(inputSymbol.trim().toUpperCase())}
        >
          Load
        </button>
        <button onClick={() => fetchSymbol(symbol)} disabled={loading} style={{ marginLeft: 8 }}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        {error && <span style={{ color: 'red' }}>Error: {error}</span>}
      </div>
      {!isValidSymbol(inputSymbol.trim().toUpperCase()) && inputSymbol.trim().length > 0 && (
        <div style={{ color: '#999', marginTop: 6 }}>Symbol must be 1–6 characters: A–Z, 0–9, dot or hyphen.</div>
      )}

      {/* Alerts banner: show high priority risk notices */}
      {metrics && ((metrics.vixCorr?.decouplingWarning) || (metrics.beta && metrics.beta > 2.8) || (metrics.annVol && metrics.annVol > 50)) && (
        <div style={{ background: '#fff4f4', borderLeft: '4px solid #F44336', padding: 12, margin: '6px 0 12px 0', borderRadius: 6 }}>
          <strong style={{ color: '#C62828' }}>⚠️ Risk Alerts:</strong>
          <div style={{ fontSize: 12, color: '#333' }}>
            {metrics.vixCorr?.decouplingWarning && <div>VIX decoupling detected (weak negative correlation despite elevated VIX).</div>}
            {metrics.beta && metrics.beta > 2.8 && <div>High leverage exposure: Beta &gt; 2.8 (leverage decay risk).</div>}
            {metrics.annVol && metrics.annVol > 50 && <div>Volatility elevated &gt; 50% (high-risk environment).</div>}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {/* Top stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Current Price</div>
              <div style={{ fontSize: 11 }}>
                {metrics?.marketState ? (
                  <span style={{ padding: '4px 8px', borderRadius: 12, background: metrics.marketState === 'REGULAR' ? '#E8F5E9' : metrics.marketState === 'PRE' ? '#FFF8E1' : metrics.marketState === 'POST' ? '#FBE9E7' : '#F5F5F5', color: metrics.marketState === 'REGULAR' ? '#2E7D32' : '#F57C00' }}>{metrics.marketState}</span>
                ) : null}
              </div>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>${metrics?.currentPrice ?? (lastAdjClose !== null ? lastAdjClose.toFixed(2) : '—')}</div>
            <div style={{ fontSize: 11, color: '#999' }}>Close: {lastDate ?? '—'}</div>
          </div>

          {/* Intraday sparkline card */}
          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>Intraday</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={intradayInterval} onChange={(e) => setIntradayInterval(e.target.value)} style={{ padding: '4px', fontSize: 12 }}>
                  <option value="1m">1m</option>
                  <option value="2m">2m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="30m">30m</option>
                  <option value="60m">60m</option>
                </select>
                <button onClick={async () => { setIntradayLoading(true); const intr = await fetchIntraday(symbol, intradayInterval); if (intr && intr.prices) { setIntradayTimes(intr.times || []); setIntradayPrices(intr.prices.map((p: any) => Number(p))); } setIntradayLoading(false); }} style={{ padding: '4px 8px' }}>Refresh</button>
              </div>
            </div>
            <div style={{ marginTop: 8, height: 60 }}>
              {intradayPrices && intradayPrices.length > 0 ? (
                <ResponsiveContainer width="100%" height={60}>
                  <LineChart data={intradayPrices.map((p, i) => ({ x: i, price: p }))} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <XAxis dataKey="x" hide />
                    <YAxis hide domain={['dataMin', 'dataMax']} />
                    <Line type="monotone" dataKey="price" stroke="#2979FF" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: '#999', fontSize: 12, padding: '8px 0' }}>{intradayLoading ? 'Loading intraday...' : 'No intraday data'}</div>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>{intradayTimes && intradayTimes.length ? `Last: ${new Date(intradayTimes[intradayTimes.length - 1]).toLocaleTimeString()}` : '—'}</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>Total Return (period)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: metrics?.totalReturn >= 0 ? '#2E7D32' : '#C62828' }}>{metrics?.totalReturn ? `${metrics.totalReturn.toFixed(2)}%` : '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>Data points: {dataPoints.length}</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>30d Ann Vol</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{metrics?.annVol ? `${metrics.annVol.toFixed(2)}%` : '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>SMA50: {metrics?.sma50 ? `$${metrics.sma50.toFixed(2)}` : '—'}</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>Momentum & Regime</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{metrics?.rsi ? `RSI ${metrics.rsi.toFixed(1)}` : '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>SMA200: {metrics?.sma200 ? `$${metrics.sma200.toFixed(2)}` : '—'}</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>Sharpe (Ann)</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{metrics?.sharpe ?? '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>Risk adjusted return</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>Max Drawdown</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{metrics?.maxDD ? `${metrics.maxDD}%` : '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>Historical worst drawdown</div>
          </div>

          <div style={{ background: '#ffffff', padding: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 12, color: '#666' }}>30d Implied Move</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{metrics?.impliedMove ? `$${metrics.impliedMove}` : '—'}</div>
            <div style={{ fontSize: 11, color: '#999' }}>{metrics?.impliedMovePercent ? `${metrics.impliedMovePercent.toFixed(2)}%` : '—'}</div>
          </div>
        </div>

        {/* Chart & side details */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <div style={{ background: 'white', borderRadius: 10, padding: 12, boxShadow: '0 6px 18px rgba(0,0,0,0.06)' }}>
            {dataPoints.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={dataPoints} margin={{ top: 6, right: 16, left: 0, bottom: 6 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickFormatter={(d) => `${d?.slice(5)}`} minTickGap={20} />
                    <YAxis domain={[dataMin => Math.floor(dataMin * 0.98), dataMax => Math.ceil(dataMax * 1.02)]} />
                    <Tooltip labelFormatter={(label) => `Date: ${label}`} formatter={(value: any) => [`$${Number(value).toFixed(2)}`, 'Price']} />
                    <ReferenceLine y={metrics?.sma50} stroke="#FFB300" strokeDasharray="5 5" label="SMA50" />
                    <ReferenceLine y={metrics?.sma200} stroke="#1976D2" strokeDasharray="5 5" label="SMA200" />
                    <Line type="monotone" dataKey="price" stroke="#2e86de" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>

                {/* Rolling Vol Chart */}
                {metrics?.rollingVolChart && metrics.rollingVolChart.length > 0 && (
                  <div style={{ marginTop: 12, height: 100 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={metrics.rollingVolChart} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                        <XAxis dataKey="idx" hide />
                        <YAxis orientation="right" width={60} />
                        <Tooltip formatter={(v: any) => [`${v}%`, '30d Vol']} />
                        <Bar dataKey="volatility" fill="#FF9800" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: '#666', padding: 40 }}>{loading ? 'Loading chart...' : 'No data to display.'}</div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: '#fff', padding: 12, borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Beta vs SPY</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{metrics?.beta ? metrics.beta.toFixed(3) : '—'}</div>
              <div style={{ fontSize: 11, color: '#999' }}>{metrics?.beta && metrics.beta > 1 ? 'High leverage exposure' : '—'}</div>
            </div>

            <div style={{ background: '#fff', padding: 12, borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: 12, color: '#666' }}>VIX Correlation</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{metrics?.vixCorr ? metrics.vixCorr.correlation : '—'}</div>
              <div style={{ fontSize: 11, color: '#999' }}>{metrics?.vixCorr?.decouplingWarning ? 'Decoupling Warning' : '—'}</div>
            </div>

            {/* Options Snapshot Card */}
            <div style={{ background: '#fff', padding: 12, borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.06)' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Options Snapshot</div>
              {metrics?.optionsSnapshot ? (
                <>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{metrics.optionsSnapshot.atmIV ? `${metrics.optionsSnapshot.atmIV.toFixed(1)}% ATM IV` : '—'}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>Expiry: {metrics.optionsSnapshot.expiration}</div>
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    <div>Surface avg IV: {metrics.optionsSnapshot.meanIV ? `${metrics.optionsSnapshot.meanIV}%` : '—'}</div>
                    <div>IV Std: {metrics.optionsSnapshot.stdIV ? `${metrics.optionsSnapshot.stdIV}%` : '—'}</div>
                    <div>Skew (Put - Call): {metrics.optionsSnapshot.skew ? `${metrics.optionsSnapshot.skew}%` : '—'}</div>
                    <div style={{ marginTop: 8 }}>Top IV strikes:</div>
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      {metrics.optionsSnapshot.topIVs.map((t: any) => (
                        <div key={t.strike} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <div>${t.strike}</div>
                          <div style={{ fontWeight: 700 }}>{t.iv.toFixed(1)}%</div>
                        </div>
                      ))}
                    </div>

                    {/* Near-term strikes table */}
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Near-term strikes (calls vs puts)</div>
                      <div style={{ overflowX: 'auto', maxHeight: 200 }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: '#666' }}>
                              <th style={{ padding: '6px 8px' }}>Strike</th>
                              <th style={{ padding: '6px 8px' }}>Call IV</th>
                              <th style={{ padding: '6px 8px' }}>Put IV</th>
                              <th style={{ padding: '6px 8px' }}>C Bid</th>
                              <th style={{ padding: '6px 8px' }}>P Bid</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.optionsSnapshot.strikeRows?.map((row: any) => (
                              <tr key={row.strike} style={{ borderTop: '1px solid #f0f0f0' }}>
                                <td style={{ padding: '6px 8px' }}>${row.strike}</td>
                                <td style={{ padding: '6px 8px', background: getIVColor(row.callIV), color: row.callIV ? '#111' : '#666', fontWeight: 700 }}>{row.callIV ? `${row.callIV.toFixed(1)}%` : '—'}</td>
                                <td style={{ padding: '6px 8px', background: getIVColor(row.putIV), color: row.putIV ? '#111' : '#666', fontWeight: 700 }}>{row.putIV ? `${row.putIV.toFixed(1)}%` : '—'}</td>
                                <td style={{ padding: '6px 8px' }}>{row.callLast ?? '—'}</td>
                                <td style={{ padding: '6px 8px' }}>{row.putLast ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* IV Surface heatmap (interactive) */}
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>IV Surface (nearest expiries)</div>
                      {surfaceLoading && <div style={{ fontSize: 12, color: '#999' }}>Loading surface...</div>}
                      {!surfaceLoading && optionsSurface && optionsSurface.surface && (
                        <div id="iv-surface-container" style={{ border: '1px solid #f0f0f0', padding: 8, borderRadius: 6, overflowX: 'auto' }}>
                          {(() => {
                            const exps = optionsSurface.surface || []
                            const strikes = Array.from(new Set(exps.flatMap((e: any) => e.strikes.map((s: any) => s.strike)))).sort((a: any, b: any) => a - b)
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ fontSize: 11, color: '#666' }}>IV Surface (nearest expiries)</div>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <button onClick={() => {
                                      const canvas = canvasRef.current
                                      if (canvas) {
                                        const url = canvas.toDataURL('image/png')
                                        const a = document.createElement('a')
                                        a.href = url
                                        a.download = `${symbol}_iv_surface.png`
                                        document.body.appendChild(a)
                                        a.click()
                                        document.body.removeChild(a)
                                      }
                                    }} style={{ padding: '6px 8px' }}>Download Image</button>
                                    <button onClick={async () => { setSurfaceLoading(true); const surf = await fetchOptionsSurface(symbol, surfaceN); setOptionsSurface(surf); setSurfaceLoading(false); }} style={{ padding: '6px 8px' }}>Refresh Surface</button>
                                  </div>
                                </div>

                                {/* Strike header */}
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <div style={{ width: 120, fontWeight: 700 }}>Expiry \ Strike</div>
                                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: 1 }}>
                                    {strikes.map((s: any) => (
                                      <div key={s} style={{ minWidth: 64, textAlign: 'center', fontSize: 11, color: '#666' }}>${s}</div>
                                    ))}
                                  </div>
                                </div>

                                {/* Canvas heatmap (WebGL) with overlay and mini-map */}
                                <div style={{ position: 'relative' }}>
                                  <canvas ref={glCanvasRef} style={{ width: '100%', height: canvasHeight, borderRadius: 6, display: 'block' }} />
                                  <canvas ref={overlayRef} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: canvasHeight, borderRadius: 6, pointerEvents: 'auto' }} />

                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, alignItems: 'center' }}>
                                    <div style={{ fontSize: 12, color: '#666' }}>Controls: Wheel = zoom • Middle-click or Alt+drag = pan • Click = drilldown • Pinch = zoom</div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                      <button onClick={() => { setSurfaceZoom(1); setSurfacePan({ x: 0, y: 0 }); }} style={{ padding: '6px 8px' }}>Reset View</button>
                                      <button onClick={() => { const canvas = glCanvasRef.current; if (canvas) { const url = canvas.toDataURL('image/png'); const a = document.createElement('a'); a.href = url; a.download = `${symbol}_iv_surface.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}} style={{ padding: '6px 8px' }}>Download</button>
                                    </div>
                                  </div>

                                  {/* Mini-map */}
                                  <div style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 10 }}>
                                    <canvas ref={miniRef} style={{ width: 160, height: 120, borderRadius: 6, boxShadow: '0 4px 10px rgba(0,0,0,0.08)', cursor: 'pointer', background: '#fff' }} />
                                  </div>

                                  {/* Tooltip */}
                                  {surfaceTooltip && (
                                    <div style={{ position: 'fixed', left: surfaceTooltip.x + 12, top: surfaceTooltip.y + 12, pointerEvents: 'none', background: '#fff', border: '1px solid #ddd', padding: 8, borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', fontSize: 12 }}>
                                      <div style={{ fontWeight: 700 }}>{surfaceTooltip.expiration} • ${surfaceTooltip.strike}</div>
                                      <div>Call IV: {surfaceTooltip.callIV ? `${surfaceTooltip.callIV.toFixed(1)}%` : '—'}</div>
                                      <div>Put IV: {surfaceTooltip.putIV ? `${surfaceTooltip.putIV.toFixed(1)}%` : '—'}</div>
                                    </div>
                                  )}

                                </div>

                              </div>
                            )
                          })()}
                        </div>
                      )}

                      {/* Refresh options button + expiry selector */}
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ fontSize: 12, color: '#666' }}>Expiries:</div>
                        <select value={surfaceN} onChange={(e) => setSurfaceN(Number(e.target.value))} style={{ padding: '6px' }}>
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <button onClick={() => refreshOptions(symbol)} style={{ padding: '8px 10px' }}>Refresh Options</button>
                        <button onClick={async () => { setSurfaceLoading(true); const surf = await fetchOptionsSurface(symbol, surfaceN); setOptionsSurface(surf); setSurfaceLoading(false); }} style={{ padding: '8px 10px' }}>Refresh Surface</button>
                      </div>

                      {/* Legend and selected strike details */}
                      {(() => {
                        const exps = optionsSurface?.surface || []
                        const ivs = exps.flatMap((e: any) => e.strikes.flatMap((s: any) => [s.callIV != null ? s.callIV * 100 : null, s.putIV != null ? s.putIV * 100 : null]).filter((v: any) => v != null))
                        const minIV = ivs.length ? Math.min(...ivs) : null
                        const maxIV = ivs.length ? Math.max(...ivs) : null
                        return (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <div style={{ fontSize: 12, color: '#666' }}>IV Legend</div>
                              <div style={{ height: 10, width: 160, borderRadius: 4, overflow: 'hidden', background: 'linear-gradient(90deg, rgb(40,200,100), rgb(240,160,80), rgb(220,60,60))' }} />
                              <div style={{ fontSize: 12, color: '#999' }}>{minIV ? `${minIV.toFixed(0)}%` : '—'}</div>
                              <div style={{ fontSize: 12, color: '#999' }}>{maxIV ? `${maxIV.toFixed(0)}%` : '—'}</div>
                            </div>

                            {surfaceSelected && (
                              <div style={{ marginTop: 8, background: '#fafafa', padding: 8, borderRadius: 6 }}>
                                <div style={{ fontWeight: 700 }}>{surfaceSelected.expiration} • ${surfaceSelected.strike}</div>
                                <div>Call IV: {surfaceSelected.callIV ? `${surfaceSelected.callIV.toFixed(1)}%` : '—'} | Last: {surfaceSelected.callLast ?? '—'}</div>
                                <div>Put IV: {surfaceSelected.putIV ? `${surfaceSelected.putIV.toFixed(1)}%` : '—'} | Last: {surfaceSelected.putLast ?? '—'}</div>
                                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                                  <button onClick={() => setSurfaceSelected(null)} style={{ padding: '6px 8px' }}>Clear</button>
                                  <button onClick={async () => {
                                    setModalLoading(true)
                                    setModalOpen(true)
                                    // fetch chain and show rows for the strike
                                    try {
                                      const chain = await fetchOptionsChain(symbol, surfaceSelected.expiration)
                                      if (chain) {
                                        const calls = (chain.calls || []).filter((c: any) => Number(c.strike) === Number(surfaceSelected.strike))
                                        const puts = (chain.puts || []).filter((p: any) => Number(p.strike) === Number(surfaceSelected.strike))
                                        setModalData({ calls, puts, strike: surfaceSelected.strike, expiration: surfaceSelected.expiration })
                                      } else {
                                        setModalData(null)
                                      }
                                    } catch (e) {
                                      setModalData(null)
                                      console.warn('Modal fetch failed', e)
                                    }
                                    setModalLoading(false)
                                  }} style={{ padding: '6px 8px' }}>Drilldown</button>
                                </div>
                              </div>
                            )}

                            {/* Modal for strike drilldown */}
                            {modalOpen && (
                              <div style={{ position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
                                <div style={{ background: '#fff', borderRadius: 8, padding: 16, width: '80%', maxHeight: '80%', overflow: 'auto' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ fontSize: 16, fontWeight: 700 }}>{modalData ? `${symbol} ${modalData.expiration} • ${modalData.strike}` : 'Loading...'}</div>
                                    <div><button onClick={() => { setModalOpen(false); setModalData(null); setSurfaceSelected(null); }} style={{ padding: '6px 8px' }}>Close</button></div>
                                  </div>
                                  {modalLoading ? (
                                    <div style={{ padding: 20 }}>Loading...</div>
                                  ) : modalData ? (
                                    <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700 }}>Calls</div>
                                        <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
                                          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                                            <thead>
                                              <tr style={{ color: '#666' }}>
                                                <th style={{ padding: '6px' }}>Strike</th>
                                                <th style={{ padding: '6px' }}>Bid</th>
                                                <th style={{ padding: '6px' }}>Ask</th>
                                                <th style={{ padding: '6px' }}>Last</th>
                                                <th style={{ padding: '6px' }}>IV</th>
                                                <th style={{ padding: '6px' }}>OI</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {modalData.calls.map((c: any, i: number) => (
                                                <tr key={i} style={{ borderTop: '1px solid #f0f0f0' }}>
                                                  <td style={{ padding: '6px' }}>{c.strike}</td>
                                                  <td style={{ padding: '6px' }}>{c.bid ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{c.ask ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{c.lastPrice ?? c.last ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{c.impliedVolatility ? `${(c.impliedVolatility*100).toFixed(1)}%` : '—'}</td>
                                                  <td style={{ padding: '6px' }}>{c.openInterest ?? c.open_interest ?? '—'}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>

                                      <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700 }}>Puts</div>
                                        <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
                                          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                                            <thead>
                                              <tr style={{ color: '#666' }}>
                                                <th style={{ padding: '6px' }}>Strike</th>
                                                <th style={{ padding: '6px' }}>Bid</th>
                                                <th style={{ padding: '6px' }}>Ask</th>
                                                <th style={{ padding: '6px' }}>Last</th>
                                                <th style={{ padding: '6px' }}>IV</th>
                                                <th style={{ padding: '6px' }}>OI</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {modalData.puts.map((p: any, i: number) => (
                                                <tr key={i} style={{ borderTop: '1px solid #f0f0f0' }}>
                                                  <td style={{ padding: '6px' }}>{p.strike}</td>
                                                  <td style={{ padding: '6px' }}>{p.bid ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{p.ask ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{p.lastPrice ?? p.last ?? '—'}</td>
                                                  <td style={{ padding: '6px' }}>{p.impliedVolatility ? `${(p.impliedVolatility*100).toFixed(1)}%` : '—'}</td>
                                                  <td style={{ padding: '6px' }}>{p.openInterest ?? p.open_interest ?? '—'}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <div style={{ padding: 12 }}>No data available for this strike.</div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })() }
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: '#999' }}>No options data available</div>
              )}
            </div>

            <div style={{ background: '#fff', padding: 12, borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, color: '#666' }}>Export</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>CSV</div>
                </div>
                <div>
                  <button onClick={() => {
                    // Export CSV of date,price
                    const csv = ['date,price', ...dataPoints.map(d => `${d.date},${d.price}`)].join('\n')
                    const blob = new Blob([csv], { type: 'text/csv' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${symbol}_prices_${new Date().toISOString().split('T')[0]}.csv`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }} style={{ padding: '8px 12px' }}>Download</button>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

// Fetch options chain expirations
const fetchOptionsExpirations = async (symbol: string) => {
  try {
    const response = await fetch(`${YFINANCE_PROXY}/api/options/${symbol}`)
    const data = await response.json()
    
    if (data.error) {
      console.warn(`❌ ${symbol} options: ${data.error}`)
      return []
    }
    
    return data.expirations || []
  } catch (error: any) {
    console.error(`❌ Error fetching options expirations:`, error)
    return []
  }
}

// Fetch options chain for specific expiration
const fetchOptionsChain = async (symbol: string, expiration: string) => {
  try {
    const response = await fetch(`${YFINANCE_PROXY}/api/options/${symbol}/${expiration}`)
    const data = await response.json()
    
    if (data.error) {
      console.warn(`❌ ${symbol} options chain: ${data.error}`)
      return null
    }
    
    console.log(`📊 Options chain for ${symbol} ${expiration}:`, data)
    console.log(`   Calls count: ${data.calls?.length || 0}, Puts count: ${data.puts?.length || 0}`)
    if (data.calls && data.calls.length > 0) {
      console.log(`   Sample call:`, data.calls[0])
    }
    
    return data
  } catch (error: any) {
    console.error(`❌ Error fetching options chain:`, error)
    return null
  }
}

// ============ CORE UTILITIES ============
const seededRandom = (seed: number) => {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

const generatePrices = (startPrice: number, volatility: number, drift: number, days: number) => {
  let prices = [startPrice]
  for (let i = 1; i < days; i++) {
    const rand = seededRandom(i * volatility * 123.456)
    const logRet = drift / 252 + volatility * Math.sqrt(1/252) * (rand - 0.5) * 2
    prices.push(prices[i-1] * Math.exp(logRet))
  }
  return prices
}

// --- Compact analytics helpers for dashboard ---
const sma = (prices: number[], n: number) => {
  if (!prices || prices.length < n) return null
  const slice = prices.slice(-n)
  const sum = slice.reduce((a, b) => a + b, 0)
  return sum / n
}

const calcAnnVol = (prices: number[]) => {
  if (!prices || prices.length < 2) return 0
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]))
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length
  const vol = Math.sqrt(variance) * Math.sqrt(252) * 100
  return vol
}

const calcBetaLocal = (prices: number[], baseline: number[]) => {
  // simple beta over aligned range
  const minLen = Math.min(prices.length, baseline.length)
  if (minLen < 2) return null
  const p = prices.slice(-minLen)
  const b = baseline.slice(-minLen)
  const rP = p.slice(1).map((x, i) => Math.log(x / p[i]))
  const rB = b.slice(1).map((x, i) => Math.log(x / b[i]))
  const meanP = rP.reduce((a, b) => a + b, 0) / rP.length
  const meanB = rB.reduce((a, b) => a + b, 0) / rP.length
  const cov = rP.reduce((a, r, i) => a + (r - meanP) * (rB[i] - meanB), 0) / rP.length
  const varB = rB.reduce((a, x) => a + Math.pow(x - meanB, 2), 0) / rB.length
  return varB > 0 ? cov / varB : null
}

const calcVIXCorrelationLocal = (prices: number[], vixPrices: number[]) => {
  const minLen = Math.min(prices.length, vixPrices.length)
  if (minLen < 2) return null
  const p = prices.slice(-minLen)
  const v = vixPrices.slice(-minLen)
  const rP = p.slice(1).map((x, i) => Math.log(x / p[i]))
  const rV = v.slice(1).map((x, i) => x - v[i]) // VIX changes
  const window = Math.min(60, rP.length)
  const recentP = rP.slice(-window)
  const recentV = rV.slice(-window)
  const meanP = recentP.reduce((a, b) => a + b, 0) / recentP.length
  const meanV = recentV.reduce((a, b) => a + b, 0) / recentV.length
  const cov = recentP.reduce((a, r, i) => a + (r - meanP) * (recentV[i] - meanV), 0) / recentP.length
  const varP = recentP.reduce((a, r) => a + Math.pow(r - meanP, 2), 0) / recentP.length
  const varV = recentV.reduce((a, r) => a + Math.pow(r - meanV, 2), 0) / recentV.length
  const corr = cov / Math.sqrt(varP * varV)
  const decouplingWarning = v[v.length - 1] > 25 && corr > -0.4
  return { correlation: isNaN(corr) ? null : corr.toFixed(3), decouplingWarning }
}

// Helper: color scale for IV (green=low IV, red=high IV)
const getIVColor = (iv: number | null) => {
  if (iv === null || iv === undefined || isNaN(iv)) return '#f5f5f5'
  const v = Math.max(0, Math.min(100, iv)) / 100
  // interpolate from green (0.05, 0.8, 0.2) to red-ish (0.9, 0.3, 0.2)
  const r = Math.round(40 + (220 - 40) * v)
  const g = Math.round(200 - (180 * v))
  const b = Math.round(80 - (40 * v))
  return `rgb(${r},${g},${b})`
}

// Refresh only options snapshot (useful for UI button)
const refreshOptions = async (sym: string) => {
  try {
    const snap = await fetchOptionsSnapshot(sym)
    setMetrics((prev: any) => ({ ...(prev || {}), optionsSnapshot: snap }))
  } catch (e) {
    console.warn('refreshOptions failed', e)
  }
}

// --- FUND-GRADE METRIC HELPERS ---
const calcSharpe = (returns: number[], riskFree: number = 0.02) => {
  if (!returns || returns.length < 2) return null
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length
  const std = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length)
  if (std === 0) return null
  // Annualize: avg * 252 / (std * sqrt(252)) = (avg/std) * sqrt(252)
  const sr = ((avg - (riskFree / 252)) / std) * Math.sqrt(252)
  return parseFloat(sr.toFixed(3))
}

const calcMaxDrawdown = (prices: number[]) => {
  if (!prices || prices.length < 2) return null
  let peak = prices[0]
  let maxDD = 0
  for (let p of prices) {
    if (p > peak) peak = p
    const dd = (peak - p) / peak
    if (dd > maxDD) maxDD = dd
  }
  return parseFloat((maxDD * 100).toFixed(2))
}

const getRollingVolChart = (prices: number[], window: number = 30) => {
  const chart: any[] = []
  if (!prices || prices.length <= window) return chart
  for (let i = window; i < prices.length; i += Math.max(1, Math.floor(window/3))) {
    const slice = prices.slice(i - window, i)
    const rets = slice.slice(1).map((p, idx) => Math.log(p / slice[idx]))
    const varr = rets.reduce((a, b) => a + Math.pow(b - (rets.reduce((x, y) => x + y, 0) / rets.length), 2), 0) / rets.length
    const vol = Math.sqrt(varr) * Math.sqrt(252) * 100
    chart.push({ idx: i, volatility: parseFloat(vol.toFixed(2)) })
  }
  return chart
}

// ============ TECHNICAL INDICATORS (SHORT-TERM TRADING EDGE) ============
// Formula: RSI = 100 - (100 / (1 + RS)) where RS = AvgGain/AvgLoss
// Formula: MACD = EMA12 - EMA26, Signal = EMA9(MACD), Histogram = MACD - Signal
// Formula: PPO = ((EMA12 - EMA26) / EMA26) × 100
const calculateTechnicals = (prices: number[]) => {
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]))
  
  // RSI (14-period) → Formula: 100 - (100 / (1 + AvgGain/AvgLoss))
  const rsiPeriod = 14
  const gains = returns.map((r: number) => r > 0 ? r : 0)
  const losses = returns.map((r: number) => r < 0 ? Math.abs(r) : 0)
  const avgGain = gains.slice(-rsiPeriod).reduce((a, b) => a + b) / rsiPeriod
  const avgLoss = losses.slice(-rsiPeriod).reduce((a, b) => a + b) / rsiPeriod
  const rs = avgGain / (avgLoss || 0.0001)
  const rsi = 100 - (100 / (1 + rs))
  
  // MACD (12/26/9) → Formula: EMA12 - EMA26, Signal Line = EMA9(MACD)
  // Calculate MACD line for all historical data points to get proper signal line
  const ema12 = calculateEMA(prices, 12)
  const ema26 = calculateEMA(prices, 26)
  const macdValues: number[] = []
  for (let i = 26; i < prices.length; i++) {
    const ema12_i = calculateEMA(prices.slice(0, i + 1), 12)
    const ema26_i = calculateEMA(prices.slice(0, i + 1), 26)
    macdValues.push(ema12_i - ema26_i)
  }
  const macdLine = macdValues[macdValues.length - 1] // Current MACD value
  const macdSignal = macdValues.length >= 9 ? calculateEMA(macdValues, 9) : macdLine
  const macdHistogram = macdLine - macdSignal
  
  // PPO (Percentage Price Oscillator) = ((EMA12 - EMA26) / EMA26) * 100
  const ppo = ((ema12 - ema26) / ema26) * 100
  
  // Volume trend (using price volatility as proxy for volume)
  const volatility30 = Math.sqrt(returns.slice(-30).reduce((a, r) => a + Math.pow(r, 2)) / 30) * Math.sqrt(252) * 100
  
  // Bollinger Bands (20-period, 2 std dev)
  const bbPeriod = 20
  const recentPrices = prices.slice(-bbPeriod)
  const sma20 = recentPrices.reduce((a, b) => a + b) / bbPeriod
  const stdDev = Math.sqrt(recentPrices.reduce((a, p) => a + Math.pow(p - sma20, 2), 0) / bbPeriod)
  const bbUpper = sma20 + 2 * stdDev
  const bbLower = sma20 - 2 * stdDev
  const currentPrice = prices[prices.length - 1]
  const bbPosition = ((currentPrice - bbLower) / (bbUpper - bbLower)) * 100
  
  // ATR (Average True Range) - 14-period
  const atrPeriod = 14
  let trueRanges = []
  for (let i = Math.max(1, prices.length - atrPeriod - 1); i < prices.length; i++) {
    const high = prices[i]
    const low = prices[i] * 0.98 // Approximation for demo
    const prevClose = prices[i - 1]
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trueRanges.push(tr)
  }
  const atr = trueRanges.reduce((a, b) => a + b) / trueRanges.length
  const atrPercent = (atr / currentPrice) * 100
  
  // Stochastic Oscillator (14-period)
  const stochPeriod = 14
  const stochPrices = prices.slice(-stochPeriod)
  const stochHigh = Math.max(...stochPrices)
  const stochLow = Math.min(...stochPrices)
  const stochK = ((currentPrice - stochLow) / (stochHigh - stochLow)) * 100
  
  // CCI (Commodity Channel Index) - 20 period
  const cciPeriod = 20
  const recentPricesForCCI = prices.slice(-cciPeriod)
  const typicalPrices = recentPricesForCCI.map((p, i) => {
    // For typical price we need high, low, close. Using approximations:
    const high = p * 1.01
    const low = p * 0.99
    return (high + low + p) / 3
  })
  const tpSMA = typicalPrices.reduce((a, b) => a + b) / typicalPrices.length
  const meanDeviation = typicalPrices.reduce((a, tp) => a + Math.abs(tp - tpSMA), 0) / typicalPrices.length
  const cci = (typicalPrices[typicalPrices.length - 1] - tpSMA) / (0.015 * meanDeviation)
  
  // Calculate ranges for indicators
  const rsiRange = 'RSI: 0-100'
  const macdRange = `MACD: ${Math.min(...macdValues).toFixed(4)} to ${Math.max(...macdValues).toFixed(4)}`
  const ppoRange = 'PPO: -10 to +10 typical'
  const cciRange = 'CCI: ±200'
  
  return {
    rsi: parseFloat(rsi.toFixed(2)),
    macd: parseFloat(macdLine.toFixed(5)),
    macdSignal: parseFloat(macdSignal.toFixed(5)),
    macdHistogram: parseFloat(macdHistogram.toFixed(5)),
    ppo: parseFloat(ppo.toFixed(3)),
    cci: parseFloat(cci.toFixed(2)),
    volumeTrend: parseFloat(volatility30.toFixed(2)),
    bbUpper: parseFloat(bbUpper.toFixed(2)),
    bbLower: parseFloat(bbLower.toFixed(2)),
    bbPosition: parseFloat(bbPosition.toFixed(1)),
    atr: parseFloat(atr.toFixed(2)),
    atrPercent: parseFloat(atrPercent.toFixed(2)),
    stochastic: parseFloat(stochK.toFixed(1)),
    rsiRange,
    macdRange,
    ppoRange,
    cciRange
  }
}

const calculateEMA = (prices: number[], period: number) => {
  const k = 2 / (period + 1)
  let ema = prices[0]
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }
  return ema
}

// ============ LONG-TERM TRADING EDGE ============
// Formula: BULL = SMA50 > SMA200 & Price > SMA50 | BEAR = opposite | SIDEWAYS = neither
// Formula: Z-Score = (Price - MA20) / StdDev20 | Z > 2 = OVERBOUGHT, Z < -2 = OVERSOLD
const calculateRegimeAndLevels = (prices: number[]) => {
  const sma50 = calculateSMA(prices, 50)
  const sma200 = calculateSMA(prices, 200)
  const currentPrice = prices[prices.length - 1]
  
  // Regime detection
  let regime = 'SIDEWAYS'
  if (sma50 > sma200 && currentPrice > sma50) regime = 'BULL'
  else if (sma50 < sma200 && currentPrice < sma50) regime = 'BEAR'
  
  // Support/Resistance (52-week high/low)
  const high52w = Math.max(...prices.slice(-252))
  const low52w = Math.min(...prices.slice(-252))
  const resistance = high52w
  const support = low52w
  
  // Trend strength (R²)
  const lookback = 60
  const recentPrices = prices.slice(-lookback)
  const trend = calculateTrendStrength(recentPrices)
  
  // Mean reversion signal
  const ma20 = calculateSMA(prices.slice(-20), 20)
  const stdDev20 = Math.sqrt(prices.slice(-20).reduce((a, p) => a + Math.pow(p - ma20, 2)) / 20)
  const zscore = (currentPrice - ma20) / stdDev20
  const meanReversionSignal = zscore > 2 ? 'OVERSOLD' : zscore < -2 ? 'OVERBOUGHT' : 'NEUTRAL'
  
  // Hurst Exponent (H < 0.5 = mean reverting, H > 0.5 = trending)
  const hurstExponent = calculateHurstExponent(prices)
  const marketBehavior = hurstExponent < 0.45 ? 'MEAN_REVERTING' : hurstExponent > 0.55 ? 'TRENDING' : 'RANDOM_WALK'
  
  return {
    regime,
    sma50: parseFloat(sma50.toFixed(2)),
    sma200: parseFloat(sma200.toFixed(2)),
    resistance: parseFloat(resistance.toFixed(2)),
    support: parseFloat(support.toFixed(2)),
    trendStrength: parseFloat(trend.toFixed(3)),
    meanReversionSignal,
    zscore: parseFloat(zscore.toFixed(2)),
    hurstExponent: parseFloat(hurstExponent.toFixed(3)),
    marketBehavior
  }
}

// ============ QUANT TRADING SIGNAL GENERATOR ============
// Multi-factor signal combining momentum, mean reversion, volatility, and regime
const generateTradingSignal = (technicals: any, regime: any, posSize: any) => {
  let bullishSignals = 0
  let bearishSignals = 0
  let reasons: string[] = []
  
  // RSI Analysis (30/70 thresholds)
  if (technicals.rsi < 30) {
    bullishSignals += 2
    reasons.push('RSI oversold (<30)')
  } else if (technicals.rsi > 70) {
    bearishSignals += 2
    reasons.push('RSI overbought (>70)')
  }
  
  // MACD Momentum
  if (technicals.macdHistogram > 0 && technicals.macd > technicals.macdSignal) {
    bullishSignals += 1
    reasons.push('MACD bullish crossover')
  } else if (technicals.macdHistogram < 0 && technicals.macd < technicals.macdSignal) {
    bearishSignals += 1
    reasons.push('MACD bearish crossover')
  }
  
  // Bollinger Bands (mean reversion)
  if (technicals.bbPosition < 10) {
    bullishSignals += 1
    reasons.push('Price near lower BB (oversold)')
  } else if (technicals.bbPosition > 90) {
    bearishSignals += 1
    reasons.push('Price near upper BB (overbought)')
  }
  
  // Regime Filter
  if (regime.regime === 'BULL') {
    bullishSignals += 1
    reasons.push('Bull market regime')
  } else if (regime.regime === 'BEAR') {
    bearishSignals += 1
    reasons.push('Bear market regime')
  }
  
  // Volatility Filter (avoid high vol)
  if (posSize.regime === 'EXTREME' || posSize.regime === 'ELEVATED') {
    bearishSignals += 0.5
    reasons.push('High volatility environment')
  } else if (posSize.regime === 'COMPRESSED') {
    bullishSignals += 0.5
    reasons.push('Low volatility (favorable)')
  }
  
  // Stochastic (overbought/oversold)
  if (technicals.stochastic < 20) {
    bullishSignals += 1
    reasons.push('Stochastic oversold (<20)')
  } else if (technicals.stochastic > 80) {
    bearishSignals += 1
    reasons.push('Stochastic overbought (>80)')
  }
  
  // Mean Reversion Z-Score
  if (regime.zscore < -2) {
    bullishSignals += 1.5
    reasons.push('Strong oversold (Z-score < -2)')
  } else if (regime.zscore > 2) {
    bearishSignals += 1.5
    reasons.push('Strong overbought (Z-score > 2)')
  }
  
  // Generate final signal
  const netSignal = bullishSignals - bearishSignals
  let action = 'HOLD'
  let confidence = 'LOW'
  let color = '#FFC107'
  let emoji = '⏸️'
  
  if (netSignal >= 3) {
    action = 'BUY'
    confidence = netSignal >= 4 ? 'HIGH' : 'MEDIUM'
    color = '#4CAF50'
    emoji = '📈'
  } else if (netSignal <= -3) {
    action = 'SELL'
    confidence = netSignal <= -4 ? 'HIGH' : 'MEDIUM'
    color = '#F44336'
    emoji = '📉'
  } else if (Math.abs(netSignal) >= 1.5) {
    action = netSignal > 0 ? 'BUY' : 'SELL'
    confidence = 'LOW'
    color = netSignal > 0 ? '#66BB6A' : '#EF5350'
    emoji = netSignal > 0 ? '📊' : '📊'
  }
  
  return {
    action,
    confidence,
    color,
    emoji,
    netSignal: netSignal.toFixed(1),
    bullishSignals: bullishSignals.toFixed(1),
    bearishSignals: bearishSignals.toFixed(1),
    reasons: reasons.slice(0, 5) // Top 5 reasons
  }
}

const calculateSMA = (prices: number[], period: number) => {
  return prices.slice(-period).reduce((a, b) => a + b) / period
}

const calculateTrendStrength = (prices: number[]) => {
  const n = prices.length
  const x = Array.from({length: n}, (_, i) => i)
  const y = prices
  const meanX = x.reduce((a, b) => a + b) / n
  const meanY = y.reduce((a, b) => a + b) / n
  const ssXX = x.reduce((a, xi) => a + Math.pow(xi - meanX, 2), 0)
  const ssYY = y.reduce((a, yi) => a + Math.pow(yi - meanY, 2), 0)
  const ssXY = x.reduce((a, xi, i) => a + (xi - meanX) * (y[i] - meanY), 0)
  return Math.pow(ssXY / Math.sqrt(ssXX * ssYY), 2)
}

const calculateHurstExponent = (prices: number[]) => {
  const lags = [5, 10, 20, 40, 80]
  const logRS = []
  
  for (const lag of lags) {
    if (prices.length < lag * 2) continue
    const chunks = Math.floor(prices.length / lag)
    let rsValues = []
    
    for (let i = 0; i < chunks; i++) {
      const chunk = prices.slice(i * lag, (i + 1) * lag)
      const mean = chunk.reduce((a, b) => a + b) / lag
      const deviations = chunk.map((p, idx) => {
        const cumDev = chunk.slice(0, idx + 1).reduce((a, b) => a + (b - mean), 0)
        return cumDev
      })
      const range = Math.max(...deviations) - Math.min(...deviations)
      const stdDev = Math.sqrt(chunk.reduce((a, p) => a + Math.pow(p - mean, 2), 0) / lag)
      if (stdDev > 0) rsValues.push(range / stdDev)
    }
    
    if (rsValues.length > 0) {
      const avgRS = rsValues.reduce((a, b) => a + b) / rsValues.length
      logRS.push({ logLag: Math.log(lag), logRS: Math.log(avgRS) })
    }
  }
  
  if (logRS.length < 2) return 0.5
  
  // Linear regression to find Hurst exponent
  const n = logRS.length
  const meanX = logRS.reduce((a, p) => a + p.logLag, 0) / n
  const meanY = logRS.reduce((a, p) => a + p.logRS, 0) / n
  const slope = logRS.reduce((a, p) => a + (p.logLag - meanX) * (p.logRS - meanY), 0) / logRS.reduce((a, p) => a + Math.pow(p.logLag - meanX, 2), 0)
  
  return Math.max(0, Math.min(1, slope))
}

// ============ OPTIONS ANALYTICS ============
// Black-Scholes Greeks Formulas:
// Delta (Δ) = N(d1) for calls, N(d1)-1 for puts | Hedge ratio & ITM probability
// Theta (Θ) = dC/dt | Daily time decay in dollars
// Vega (ν) = dC/dσ | Change per 1% IV move
// Gamma (Γ) = d²C/dS² | Delta acceleration (convexity)
// Implied Move = Spot × IV × √(DTE/365) | Expected 1σ range
const calculateOptionsGreeks = (spot: number, strike: number, daysToExpiry: number, volatility: number, riskFreeRate: number) => {
  const iv = volatility / 100
  const t = daysToExpiry / 365
  
  const d1 = (Math.log(spot / strike) + (riskFreeRate + Math.pow(iv, 2) / 2) * t) / (iv * Math.sqrt(t))
  const d2 = d1 - iv * Math.sqrt(t)
  
  const delta = normCDF(d1)
  const deltaPut = delta - 1
  const gamma = normPDF(d1) / (spot * iv * Math.sqrt(t))
  const vega = (spot * normPDF(d1) * Math.sqrt(t)) / 100
  const theta = -(spot * normPDF(d1) * iv / (2 * Math.sqrt(t)) + riskFreeRate * strike * Math.exp(-riskFreeRate * t) * normCDF(d2)) / 365
  
  const deltaWarning = Math.abs(delta) > 0.7
  const gammaWarning = gamma > 0.05
  
  return {
    delta: parseFloat(delta.toFixed(3)),
    deltaPut: parseFloat(deltaPut.toFixed(3)),
    gamma: parseFloat(gamma.toFixed(5)),
    vega: parseFloat(vega.toFixed(2)),
    theta: parseFloat((theta * spot).toFixed(2)),
    deltaWarning,
    gammaWarning
  }
}

const calculateOptionsMetrics = (prices: number[], volatility: number) => {
  const spot = prices[prices.length - 1]
  const iv = volatility / 100 // Convert to decimal
  const daysToExpiry = 30
  const riskFreeRate = 0.02
  
  // ATM strike
  const atmStrike = spot
  
  // Black-Scholes Greeks
  const d1 = (Math.log(spot / atmStrike) + (riskFreeRate + Math.pow(iv, 2) / 2) * (daysToExpiry / 365)) / (iv * Math.sqrt(daysToExpiry / 365))
  const d2 = d1 - iv * Math.sqrt(daysToExpiry / 365)
  
  const callDelta = normCDF(d1)
  const callTheta = -(spot * normPDF(d1) * iv / (2 * Math.sqrt(daysToExpiry / 365)) + riskFreeRate * atmStrike * Math.exp(-riskFreeRate * (daysToExpiry / 365)) * normCDF(d2)) / 365
  const callVega = (spot * normPDF(d1) * Math.sqrt(daysToExpiry / 365)) / 100
  const callGamma = normPDF(d1) / (spot * iv * Math.sqrt(daysToExpiry / 365))
  
  const callPrice = spot * callDelta - atmStrike * Math.exp(-riskFreeRate * (daysToExpiry / 365)) * normCDF(d2)
  const putPrice = callPrice - spot + atmStrike * Math.exp(-riskFreeRate * (daysToExpiry / 365))
  const putDelta = callDelta - 1
  
  // Implied Move
  const impliedMove = spot * iv * Math.sqrt(daysToExpiry / 365)
  
  // Put/Call Ratio indicator
  const putCallRatio = putPrice / callPrice
  
  return {
    atmStrike: parseFloat(atmStrike.toFixed(2)),
    callPrice: parseFloat(callPrice.toFixed(2)),
    putPrice: parseFloat(putPrice.toFixed(2)),
    callDelta: parseFloat(callDelta.toFixed(3)),
    putDelta: parseFloat(putDelta.toFixed(3)),
    callTheta: parseFloat((callTheta * spot).toFixed(2)),
    callVega: parseFloat(callVega.toFixed(2)),
    callGamma: parseFloat(callGamma.toFixed(5)),
    impliedMove: parseFloat(impliedMove.toFixed(2)),
    impliedMovePercent: parseFloat(((impliedMove / spot) * 100).toFixed(2)),
    putCallRatio: parseFloat(putCallRatio.toFixed(2)),
    optionVolume: Math.floor(Math.random() * 100000 + 50000), // Simulated
    openInterest: Math.floor(Math.random() * 500000 + 200000) // Simulated
  }
}

// Fetch options snapshot and compute ATM IV + surface summary
const fetchOptionsSnapshot = async (symbol: string) => {
  try {
    const exps = await fetchOptionsExpirations(symbol)
    if (!exps || exps.length === 0) return null
    const exp = exps[0]
    const chain = await fetchOptionsChain(symbol, exp)
    if (!chain) return null

    const calls = (chain.calls || []).map((c: any) => ({ strike: c.strike, iv: (c.impliedVolatility ?? c.iv ?? null) }))
    const puts = (chain.puts || []).map((p: any) => ({ strike: p.strike, iv: (p.impliedVolatility ?? p.iv ?? null) }))
    const spot = (await fetch(`${YFINANCE_PROXY}/api/live/${symbol}`).then(r => r.json())).lastAdjClose

    // Merge strikes
    const strikesSet = Array.from(new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)])).sort((a,b) => a-b)
    // ATM strike nearest
    const atmStrike = strikesSet.reduce((a: number, b: number) => Math.abs(b - spot) < Math.abs(a - spot) ? b : a, strikesSet[0])

    const atmCall = calls.find((c: any) => c.strike === atmStrike)
    const atmPut = puts.find((p: any) => p.strike === atmStrike)
    const atmIV = ((atmCall?.iv ?? atmPut?.iv ?? null) !== null) ? (( (atmCall?.iv ?? atmPut?.iv) * 100 )) : null

    // Surface stats
    const allIVs = [...calls, ...puts].map(o => o.iv).filter(Boolean).map((v: any) => v * 100)
    const meanIV = allIVs.length ? (allIVs.reduce((a, b) => a + b, 0) / allIVs.length) : null
    const stdIV = allIVs.length ? Math.sqrt(allIVs.reduce((a, b) => a + Math.pow(b - meanIV, 2), 0) / allIVs.length) : null

    // Skew: mean put IV - mean call IV
    const meanPut = puts.filter(p => p.iv).map(p => p.iv * 100).reduce((a,b) => a + b, 0) / Math.max(1, puts.filter(p => p.iv).length)
    const meanCall = calls.filter(c => c.iv).map(c => c.iv * 100).reduce((a,b) => a + b, 0) / Math.max(1, calls.filter(c => c.iv).length)
    const skew = (meanPut && meanCall) ? (meanPut - meanCall) : null

    // Top 5 IV strikes
    const topIVs = [...calls, ...puts].filter(o => o.iv).map(o => ({ strike: o.strike, iv: o.iv * 100 })).sort((a,b) => b.iv - a.iv).slice(0,5)

    // Prepare near-term strike rows centered on ATM
    const strikes = strikesSet
    const atmIndex = strikes.indexOf(atmStrike)
    const windowSize = 4
    const start = Math.max(0, atmIndex - windowSize)
    const end = Math.min(strikes.length, atmIndex + windowSize + 1)
    const strikeRows = strikes.slice(start, end).map(s => {
      const call = calls.find(c => c.strike === s) || {}
      const put = puts.find(p => p.strike === s) || {}
      return {
        strike: s,
        callIV: call.iv !== undefined && call.iv !== null ? call.iv * 100 : null,
        putIV: put.iv !== undefined && put.iv !== null ? put.iv * 100 : null,
        callLast: call.lastPrice ?? call.last ?? null,
        putLast: put.lastPrice ?? put.last ?? null,
        callOI: call.openInterest ?? call.open_interest ?? null,
        putOI: put.openInterest ?? put.open_interest ?? null
      }
    })

    // Implied move (30d) from ATM IV
    let impliedMove = null
    let impliedMovePercent = null
    if (atmIV !== null) {
      const daysToExpiry = Math.max(1, Math.floor((new Date(exp).getTime() - new Date().getTime()) / (1000*60*60*24)))
      impliedMovePercent = atmIV * Math.sqrt(daysToExpiry / 365)
      impliedMove = parseFloat((spot * (impliedMovePercent / 100)).toFixed(2))
    }

    return { expiration: exp, atmStrike, atmIV, meanIV: meanIV ? parseFloat(meanIV.toFixed(2)) : null, stdIV: stdIV ? parseFloat(stdIV.toFixed(2)) : null, skew: skew ? parseFloat(skew.toFixed(2)) : null, topIVs, impliedMove, impliedMovePercent, strikeRows }
  } catch (e) {
    console.warn('fetchOptionsSnapshot failed', e)
    return null
  }
}

// --- New: fetch intraday series from proxy ---
const fetchIntraday = async (symbol: string, interval: string = '1m') => {
  try {
    const res = await fetch(`${YFINANCE_PROXY}/api/intraday/${encodeURIComponent(symbol)}?interval=${interval}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const json = await res.json()
    return json
  } catch (e) {
    console.warn('fetchIntraday failed', e)
    return null
  }
}

// --- New: fetch IV surface across nearest n expirations ---
const fetchOptionsSurface = async (symbol: string, n: number = 3) => {
  try {
    const res = await fetch(`${YFINANCE_PROXY}/api/options/surface/${encodeURIComponent(symbol)}?n=${n}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const json = await res.json()
    return json
  } catch (e) {
    console.warn('fetchOptionsSurface failed', e)
    return null
  }
}

const normCDF = (x: number) => {
  return (1 + erf(x / Math.sqrt(2))) / 2
}

const normPDF = (x: number) => {
  return Math.exp(-Math.pow(x, 2) / 2) / Math.sqrt(2 * Math.PI)
}

const erf = (x: number) => {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x)
  return sign * y
}

const mockDataCache = {
  SOXL: { prices: generatePrices(20, 0.45, 0.15, 3500), description: '3x leveraged semiconductor ETF' },
  SOXX: { prices: generatePrices(400, 0.35, 0.12, 3500), description: 'Semiconductor index ETF' },
  SPY: { prices: generatePrices(100, 0.15, 0.10, 3500), description: 'S&P 500 ETF' },
  VXX: { prices: generatePrices(25, 0.60, -0.05, 3500), description: 'VIX Short-Term Futures ETF' },
  VIX: { prices: generatePrices(20, 0.25, 0.02, 3500), description: 'Volatility index (Mock only)' }
}

/* LegacyApp implementation moved to src/LegacyApp.tsx */
function LegacyApp_disabled() {
  const [metrics, setMetrics] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [optionalTicker, setOptionalTicker] = useState('SOXL')
  const [patterns, setPatterns] = useState<any>(null)
  
  // Options selling dashboard state - load from localStorage if available
  const [optionsPositions, setOptionsPositions] = useState(() => {
    const saved = localStorage.getItem('soxl_options_positions')
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch (e) {
        console.error('Failed to load saved positions:', e)
      }
    }
    // Default positions if nothing saved
    return {
      pos1: { type: 'CSP', strike: 50, dte: 30, shares: 100, pricePerContract: 2.50 },
      pos2: { type: 'CC', strike: 55, dte: 45, shares: 200, pricePerContract: 1.75 },
      pos3: { type: 'CSP', strike: 45, dte: 60, shares: 300, pricePerContract: 3.20 }
    }
  })
  
  // Alert system state
  const [alerts, setAlerts] = useState<any[]>([])
  const [alertHistory, setAlertHistory] = useState<any[]>([])
  const [lastUpdated, setLastUpdated] = useState<string>('')
  
  // Options chain state
  const [optionsExpirations, setOptionsExpirations] = useState<string[]>([])
  const [selectedExpiration, setSelectedExpiration] = useState<string>('')
  const [optionsChainData, setOptionsChainData] = useState<any>(null)
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null)
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [optionTypeView, setOptionTypeView] = useState<'calls' | 'puts'>('puts') // Default to puts (CSP)
  
  // Alert checking function
  const checkAlerts = (metricsData: any) => {
    const newAlerts: any[] = []
    const timestamp = new Date().toLocaleString()
    
    Object.entries(metricsData).forEach(([symbol, m]: [string, any]) => {
      // RSI alerts
      if (m.technicals) {
        if (m.technicals.rsi < 30) {
          newAlerts.push({
            symbol,
            type: 'RSI_OVERSOLD',
            severity: 'BUY',
            message: `${symbol} RSI dropped to ${m.technicals.rsi.toFixed(1)} - OVERSOLD`,
            timestamp,
            color: '#4CAF50'
          })
        }
        if (m.technicals.rsi > 70) {
          newAlerts.push({
            symbol,
            type: 'RSI_OVERBOUGHT',
            severity: 'SELL',
            message: `${symbol} RSI spiked to ${m.technicals.rsi.toFixed(1)} - OVERBOUGHT`,
            timestamp,
            color: '#F44336'
          })
        }
      }
      
      // VIX decoupling alert
      if (m.vixCorrelation?.decouplingWarning) {
        newAlerts.push({
          symbol,
          type: 'VIX_DECOUPLING',
          severity: 'WARNING',
          message: `${symbol} decoupling from VIX - VIX: ${m.vixCorrelation.currentVIX}, Correlation: ${m.vixCorrelation.correlation}`,
          timestamp,
          color: '#D32F2F'
        })
      }
      
      // Beta decay alert
      if (m.beta?.decayWarning) {
        newAlerts.push({
          symbol,
          type: 'BETA_DECAY',
          severity: 'WARNING',
          message: `${symbol} beta decay detected - Current: ${m.beta.current}, below threshold 2.8`,
          timestamp,
          color: '#F44336'
        })
      }
      
      // Regime change alert
      if (m.regime && m.posSize) {
        if (m.posSize.regime === 'ELEVATED' || m.posSize.regime === 'EXTREME') {
          newAlerts.push({
            symbol,
            type: 'REGIME_CHANGE',
            severity: 'WARNING',
            message: `${symbol} entered ${m.posSize.regime} volatility regime - Reduce position to ${m.posSize.size}%`,
            timestamp,
            color: m.posSize.color
          })
        }
      }
      
      // Volatility spike alert
      // For VIX: alert when VIX level itself is high (>25 = elevated fear, >30 = extreme fear)
      // For stocks: alert when their volatility is high (>50%)
      if (symbol === 'VIX') {
        const vixLevel = parseFloat(m.currentPrice)
        if (vixLevel > 30) {
          newAlerts.push({
            symbol,
            type: 'VOLATILITY_SPIKE',
            severity: 'WARNING',
            message: `VIX at ${vixLevel.toFixed(2)} - EXTREME FEAR - Market panic levels`,
            timestamp,
            color: '#FF5722'
          })
        } else if (vixLevel > 25) {
          newAlerts.push({
            symbol,
            type: 'VOLATILITY_SPIKE',
            severity: 'WARNING',
            message: `VIX at ${vixLevel.toFixed(2)} - ELEVATED FEAR - Above normal risk`,
            timestamp,
            color: '#FF9800'
          })
        }
      } else if (parseFloat(m.annVol) > 50) {
        newAlerts.push({
          symbol,
          type: 'VOLATILITY_SPIKE',
          severity: 'WARNING',
          message: `${symbol} volatility spiked to ${m.annVol}% - High risk environment`,
          timestamp,
          color: '#FF5722'
        })
      }
    })
    
    setAlerts(newAlerts)
    
    // Append new alerts to history (keep last 50)
    if (newAlerts.length > 0) {
      setAlertHistory(prev => [...newAlerts, ...prev].slice(0, 50))
    }
    
    return newAlerts
  }
  
  const updatePosition = (position: 'pos1' | 'pos2' | 'pos3', field: string, value: number | string) => {
    setOptionsPositions(prev => {
      const updated = { ...prev[position], [field]: value }
      
      // When strike or DTE changes, look up the matching option and update premium
      if ((field === 'strike' || field === 'dte') && optionsChainData.calls.length > 0) {
        const posType = updated.type
        const chainData = posType === 'CC' ? optionsChainData.calls : optionsChainData.puts
        
        // Find matching option by strike
        const matchingOption = chainData.find((opt: any) => opt.strike === updated.strike)
        
        if (matchingOption) {
          const lastPrice = matchingOption.lastPrice || ((matchingOption.bid + matchingOption.ask) / 2) || 0
          updated.pricePerContract = parseFloat(lastPrice.toFixed(2))
          console.log(`✅ Auto-updated ${position} premium to $${updated.pricePerContract} for strike $${updated.strike}`)
        }
      }
      
      return {
        ...prev,
        [position]: updated
      }
    })
  }
  
  // Populate position from options chain
  const populatePositionFromChain = (position: 'pos1' | 'pos2' | 'pos3', option: any, type: 'CC' | 'CSP') => {
    const daysToExp = Math.floor((new Date(selectedExpiration).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    const lastPrice = option.lastPrice || ((option.bid + option.ask) / 2) || 0
    
    setOptionsPositions(prev => ({
      ...prev,
      [position]: {
        type,
        strike: option.strike,
        dte: daysToExp,
        shares: prev[position].shares, // Keep existing shares
        pricePerContract: parseFloat(lastPrice.toFixed(2))
      }
    }))
    
    console.log(`✅ Populated ${position} with ${type} at strike $${option.strike}, premium $${lastPrice.toFixed(2)}`)
  }
  
  // Export to Excel/CSV function
  const exportToExcel = () => {
    const csvHeader = 'Position,Strike Price,DTE,# of Shares,Price per Contract,Premium,ACB (CSP),ROI (%)\n'
    const rows = ['pos1', 'pos2', 'pos3'].map((posKey, idx) => {
      const pos = optionsPositions[posKey as keyof typeof optionsPositions]
      const premium = (pos.pricePerContract * pos.shares).toFixed(2)
      const acb = (pos.strike - ((pos.pricePerContract * pos.shares) / pos.shares)).toFixed(2)
      const roi = (((pos.pricePerContract * pos.shares) / (pos.strike * pos.shares)) * 100).toFixed(2)
      return `Position #${idx + 1},${pos.strike},${pos.dte},${pos.shares},${pos.pricePerContract},${premium},${acb},${roi}`
    }).join('\n')
    
    const csvContent = csvHeader + rows
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `options_positions_${new Date().toISOString().split('T')[0]}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }
  
  // PDF Report Generation
  const exportWatchlistCSV = () => {
    const symbols = Object.keys(metrics).filter(s => !metrics[s].error)
    
    let csv = 'Symbol,Regime,Volatility,Signal,Action,Confidence,Position Size,Current Price,Beta,Sharpe Ratio\n'
    
    symbols.forEach(symbol => {
      const m = metrics[symbol]
      const regime = m.posSize?.regime || 'N/A'
      const vol = m.annVol || 'N/A'
      const signal = m.signal?.action || 'N/A'
      const confidence = m.signal?.confidence || 'N/A'
      const posSize = m.posSize?.size || 'N/A'
      const price = m.currentPrice || 'N/A'
      const beta = m.beta?.current || 'N/A'
      const sharpe = m.backtest?.sharpeRatio || 'N/A'
      
      csv += `${symbol},${regime},${vol}%,${signal},${signal},${confidence},${posSize}%,$${price},${beta},${sharpe}\n`
    })
    
    // Create download link
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `watchlist_export_${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  }
  
  const generatePDFReport = () => {
    // Use browser's print API to generate PDF
    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      alert('Please allow popups to generate PDF report')
      return
    }
    
    const reportHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Quant Analytics Report - ${new Date().toLocaleDateString()}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h1 { color: #667eea; }
          h2 { color: #2c3e50; border-bottom: 2px solid #667eea; padding-bottom: 5px; }
          .metric { display: inline-block; margin: 10px; padding: 15px; border: 1px solid #ddd; border-radius: 8px; }
          .alert { background: #fff3cd; padding: 10px; border-left: 4px solid #FF9800; margin: 10px 0; }
          .positive { color: #4CAF50; font-weight: bold; }
          .negative { color: #F44336; font-weight: bold; }
          @media print { body { margin: 0; } }
        </style>
      </head>
      <body>
        <h1>🚀 Elite Quant Analytics Report</h1>
        <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
        <p><strong>Ticker:</strong> ${optionalTicker}</p>
        
        ${alerts.length > 0 ? `
        <h2>🚨 Active Alerts (${alerts.length})</h2>
        ${alerts.map(alert => `
          <div class="alert">
            <strong>${alert.symbol} - ${alert.severity}:</strong> ${alert.message}
          </div>
        `).join('')}
        ` : ''}
        
        ${metrics ? Object.entries(metrics).map(([symbol, m]: [string, any]) => `
          <h2>${symbol} - ${m.description}</h2>
          <div>
            <div class="metric">
              <strong>Volatility:</strong> ${m.annVol}%
            </div>
            <div class="metric">
              <strong>6-Month Return:</strong> <span class="${parseFloat(m.totalReturn) >= 0 ? 'positive' : 'negative'}">${m.totalReturn}%</span>
            </div>
            ${m.posSize ? `
            <div class="metric">
              <strong>Regime:</strong> ${m.posSize.regime} (Size: ${m.posSize.size}%)
            </div>
            ` : ''}
            ${m.beta ? `
            <div class="metric">
              <strong>Beta (vs SPY):</strong> ${m.beta.beta} [${m.beta.ciLow}, ${m.beta.ciHigh}]
            </div>
            ` : ''}
            ${m.backtest ? `
            <div class="metric">
              <strong>Strategy Return:</strong> <span class="positive">+${m.backtest.finalReturn}%</span>
            </div>
            <div class="metric">
              <strong>Buy & Hold:</strong> <span class="positive">+${m.backtest.buyHold}%</span>
            </div>
            <div class="metric">
              <strong>Sharpe Ratio:</strong> ${m.backtest.sharpeRatio}
            </div>
            <div class="metric">
              <strong>Max Drawdown:</strong> <span class="negative">-${m.backtest.maxDD}%</span>
            </div>
            ` : ''}
          </div>
          ${m.signal ? `
          <h3>Trading Signal</h3>
          <div style="background: ${m.signal.color}15; padding: 15px; border-left: 4px solid ${m.signal.color};">
            <strong>${m.signal.action}</strong> - ${m.signal.confidence} Confidence
            <ul>
              ${m.signal.reasons.map((r: string) => `<li>${r}</li>`).join('')}
            </ul>
          </div>
          ` : ''}
        `).join('') : ''}
        
        <hr style="margin: 30px 0;">
        <p style="font-size: 12px; color: #666;">
          <strong>Disclaimer:</strong> This report is for informational purposes only. Not financial advice. 
          Past performance does not guarantee future results.
        </p>
      </body>
      </html>
    `
    
    printWindow.document.write(reportHTML)
    printWindow.document.close()
    printWindow.print()
  }

  const loadData = async () => {
    setLoading(true)
    setError('')
    
    console.log('🚀 Starting data load...')
    console.log('USE_LIVE_DATA:', USE_LIVE_DATA)
    
    // Fetch live data or use mock data
    // Note: yfinance uses ^VIX for VIX index
    const tickers = [optionalTicker, 'SOXX', 'SPY', '^VIX']
    console.log('📋 Tickers to fetch:', tickers)
    
    // Add delay function to respect API rate limits (1 call per second)
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    
    const dataPromises = USE_LIVE_DATA 
      ? tickers.map(async (ticker, index) => {
          // Wait 2 seconds between each API call to avoid rate limits
          await delay(index * 2000)
          const liveData = await fetchLiveData(ticker)
          const hasMockData = mockDataCache[ticker as keyof typeof mockDataCache]?.prices
          const result = {
            ticker,
            prices: liveData?.prices || hasMockData || mockDataCache.SOXL.prices,
            description: liveData ? `${ticker} (Live Data)` : `${ticker} (Mock Data)`,
            isLive: !!liveData,
            lastAdjClose: liveData?.lastAdjClose,
            lastDate: liveData?.lastDate
          }
          console.log(`📦 ${ticker} result:`, { isLive: result.isLive, dataPoints: result.prices.length, lastAdjClose: result.lastAdjClose })
          return result
        })
      : tickers.map(ticker => ({
          ticker,
          prices: mockDataCache[ticker as keyof typeof mockDataCache]?.prices || mockDataCache.SOXL.prices,
          description: `${ticker} (Mock Data)`,
          isLive: false,
          lastAdjClose: null,
          lastDate: null
        }))
    
    const dataResults = await Promise.all(dataPromises)
    const mockData: any = {}
    dataResults.forEach(({ ticker, prices, description, isLive, lastAdjClose, lastDate }) => {
      // Map ^VIX to VIX for display consistency
      const displayTicker = ticker === '^VIX' ? 'VIX' : ticker
      mockData[displayTicker] = { prices, description: description.replace('^VIX', 'VIX') + (isLive ? ' ✅' : ''), isLive, lastAdjClose, lastDate }
    })
    
    try {
      const results: any = {}
      Object.entries(mockData).forEach(([symbol, {prices, description}]) => {
        if (prices.length < 2) { results[symbol] = {error: 'Insufficient data'}; return }
        
        const technicals = calculateTechnicals(prices)
        const regime = calculateRegimeAndLevels(prices)
        const options = calculateOptionsMetrics(prices, parseFloat(regime.trendStrength as any) * 30)
        const backtest = calculateBacktest(prices)
        const volChart = getRollingVolChart(prices)
        
        // VIX correlation (risk-off indicator)
        const vixCorrelation = symbol !== 'VIX' && mockData['VIX'] ? calculateVIXCorrelation(prices, mockData['VIX'].prices) : null
        
        const returns = prices.slice(1).map((p: number, i: number) => Math.log(p / prices[i]))
        const variance = returns.reduce((a: number, b: number) => a + Math.pow(b - returns.reduce((x, y) => x + y) / returns.length, 2)) / returns.length
        const annVol = Math.sqrt(variance) * Math.sqrt(252) * 100
        const totalReturn = ((prices[prices.length - 1] / prices[0]) - 1) * 100
        
        const posSize = getPositionSize(annVol)
        let beta = null
        if (symbol !== 'SPY' && symbol !== 'VIX') {
          beta = calculateBeta(prices, mockData['SPY' as keyof typeof mockData].prices)
        }

        results[symbol] = {
          annVol: annVol.toFixed(2),
          totalReturn: totalReturn.toFixed(2),
          dataPoints: prices.length,
          startPrice: prices[0].toFixed(2),
          currentPrice: prices[prices.length - 1].toFixed(2),
          description,
          posSize,
          beta,
          backtest,
          volChart,
          technicals,
          regime,
          options,
          vixCorrelation,
          lastAdjClose: mockData[symbol].lastAdjClose,
          lastDate: mockData[symbol].lastDate
        }
      })

      setMetrics(results)
      checkAlerts(results) // Check for alerts after updating metrics
      
      // Update last refreshed timestamp
      const now = new Date()
      const formatted = now.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/New_York',
        timeZoneName: 'short'
      })
      setLastUpdated(formatted)
      analyzePatterns(results, mockData)
    } catch (e: any) {
      setError(typeof e === 'string' ? e : (e?.message || 'Unknown error'))
    } finally {
      setLoading(false)
    }
  }
  
  // ============ CONSOLIDATED UTILITIES ============
  const calculateBeta = (prices: number[], baselinePrices: number[], window: number = 60) => {
    const returns = prices.slice(1).map((p: number, i: number) => Math.log(p / prices[i]))
    const baselineReturns = baselinePrices.slice(1).map((p: number, i: number) => Math.log(p / baselinePrices[i]))
    let betas = []
    let rollingBetaChart: any[] = [] // For chart visualization
    const maxI = Math.min(returns.length, baselineReturns.length)
    for (let i = window; i < maxI; i++) {
      const windowReturns = returns.slice(i - window, i)
      const windowBaselineReturns = baselineReturns.slice(i - window, i)
      const meanR = windowReturns.reduce((a, b) => a + b) / window
      const meanB = windowBaselineReturns.reduce((a, b) => a + b) / window
      const covariance = windowReturns.reduce((a, r, idx) => a + (r - meanR) * (windowBaselineReturns[idx] - meanB), 0) / window
      const baselineVar = windowBaselineReturns.reduce((a, b) => a + Math.pow(b - meanB, 2), 0) / window
      const beta = baselineVar > 0 ? covariance / baselineVar : 0
      betas.push(beta)
      // Add to chart data (sample every 5 days to reduce data points)
      if (i % 5 === 0) {
        rollingBetaChart.push({
          day: i,
          beta: parseFloat(beta.toFixed(3)),
          threshold: 2.8 // Visual threshold line
        })
      }
    }
    const avgBeta = betas.reduce((a, b) => a + b) / betas.length
    const betaVariance = betas.reduce((a, b) => a + Math.pow(b - avgBeta, 2)) / betas.length
    const betaSE = Math.sqrt(betaVariance / betas.length)
    const currentBeta = betas[betas.length - 1]
    const decayWarning = currentBeta < 2.8 && avgBeta > 2.8 // Beta dropping below threshold
    
    // Check for consecutive days below 2.8
    const recentBetas = betas.slice(-10) // Last 10 days
    let consecutiveDaysBelow28 = 0
    for (let i = recentBetas.length - 1; i >= 0; i--) {
      if (recentBetas[i] < 2.8) {
        consecutiveDaysBelow28++
      } else {
        break
      }
    }
    const leverageDecayAlert = consecutiveDaysBelow28 >= 3
    
    return { 
      beta: avgBeta.toFixed(3), 
      se: betaSE.toFixed(4), 
      ciLow: (avgBeta - 1.96 * betaSE).toFixed(3), 
      ciHigh: (avgBeta + 1.96 * betaSE).toFixed(3),
      current: currentBeta.toFixed(3),
      rollingBetaChart,
      decayWarning,
      leverageDecayAlert,
      consecutiveDaysBelow28
    }
  }
  
  const calculateVIXCorrelation = (prices: number[], vixPrices: number[], window: number = 60) => {
    const returns = prices.slice(1).map((p: number, i: number) => Math.log(p / prices[i]))
    const vixChanges = vixPrices.slice(1).map((p: number, i: number) => p - vixPrices[i]) // VIX changes, not returns
    const maxI = Math.min(returns.length, vixChanges.length)
    
    // Calculate rolling correlation for chart
    let rollingCorrelations: any[] = []
    for (let i = window; i < maxI; i++) {
      const windowReturns = returns.slice(i - window, i)
      const windowVixChanges = vixChanges.slice(i - window, i)
      const meanR = windowReturns.reduce((a, b) => a + b) / window
      const meanV = windowVixChanges.reduce((a, b) => a + b) / window
      const covariance = windowReturns.reduce((a, r, idx) => a + (r - meanR) * (windowVixChanges[idx] - meanV), 0) / window
      const varR = windowReturns.reduce((a, r) => a + Math.pow(r - meanR, 2), 0) / window
      const varV = windowVixChanges.reduce((a, v) => a + Math.pow(v - meanV, 2), 0) / window
      const correlation = covariance / Math.sqrt(varR * varV)
      if (i % 5 === 0) {
        rollingCorrelations.push({
          day: i,
          correlation: parseFloat(correlation.toFixed(3))
        })
      }
    }
    
    // Current correlation (most recent window)
    const recentReturns = returns.slice(-window)
    const recentVix = vixChanges.slice(-window)
    const meanR = recentReturns.reduce((a, b) => a + b) / window
    const meanV = recentVix.reduce((a, b) => a + b) / window
    const covariance = recentReturns.reduce((a, r, idx) => a + (r - meanR) * (recentVix[idx] - meanV), 0) / window
    const varR = recentReturns.reduce((a, r) => a + Math.pow(r - meanR, 2), 0) / window
    const varV = recentVix.reduce((a, v) => a + Math.pow(v - meanV, 2), 0) / window
    const correlation = covariance / Math.sqrt(varR * varV)
    
    const currentVIX = vixPrices[vixPrices.length - 1]
    const decouplingWarning = currentVIX > 25 && correlation > -0.4 // VIX high but weak negative correlation
    const signal = correlation < -0.3 ? 'RISK_OFF' : correlation > 0.3 ? 'RISK_ON' : 'NEUTRAL'
    
    // Calculate VIX Decoupling Severity Score (0-10)
    let severityScore = 0
    if (currentVIX > 25 && correlation > -0.4) {
      // High risk: VIX >25 and correlation > -0.4
      severityScore = 7 + Math.min(3, (correlation + 0.4) / 0.2 * 3) // 7-10
    } else if (currentVIX >= 20 && currentVIX <= 25 && correlation > -0.3) {
      // Medium risk: VIX 20-25 and correlation > -0.3
      severityScore = 4 + Math.min(2, (correlation + 0.3) / 0.3 * 2) // 4-6
    } else if (currentVIX >= 15 && currentVIX < 20 && correlation > -0.2) {
      // Low-medium risk
      severityScore = 2 + Math.min(2, (correlation + 0.2) / 0.4 * 2) // 2-4
    } else if (currentVIX < 15 || correlation < -0.5) {
      // Very low risk
      severityScore = 0
    } else {
      // Neutral
      severityScore = 1
    }
    
    return { 
      correlation: correlation.toFixed(3), 
      signal,
      rollingCorrelations,
      currentVIX: currentVIX.toFixed(2),
      decouplingWarning,
      severityScore: parseFloat(severityScore.toFixed(1))
    }
  }
  
  // ============ OPTIONS GREEKS (BLACK-SCHOLES MODEL) ============
  const calculateOptionsGreeks = (spotPrice: number, strikePrice: number, daysToExpiry: number, volatility: number, riskFreeRate: number = 0.05, optionType: 'call' | 'put' = 'put') => {
    const S = spotPrice
    const K = strikePrice
    const T = daysToExpiry / 365
    const v = volatility / 100
    const r = riskFreeRate
    
    if (T <= 0) return { delta: 0, gamma: 0, vega: 0, theta: 0, price: 0 }
    
    // Standard normal cumulative distribution function
    const normCDF = (x: number) => {
      const t = 1 / (1 + 0.2316419 * Math.abs(x))
      const d = 0.3989423 * Math.exp(-x * x / 2)
      const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
      return x > 0 ? 1 - prob : prob
    }
    
    // Standard normal probability density function
    const normPDF = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
    
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T))
    const d2 = d1 - v * Math.sqrt(T)
    
    let price, delta, gamma, vega, theta
    
    if (optionType === 'call') {
      price = S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
      delta = normCDF(d1)
      theta = (-S * normPDF(d1) * v / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    } else {
      price = K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1)
      delta = normCDF(d1) - 1
      theta = (-S * normPDF(d1) * v / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365
    }
    
    gamma = normPDF(d1) / (S * v * Math.sqrt(T))
    vega = S * normPDF(d1) * Math.sqrt(T) / 100
    
    // Alerts
    const deltaWarning = optionType === 'call' && delta > 0.7 // High assignment risk for CC
    const gammaWarning = gamma > 0.05 // High gamma = explosive move potential
    
    return {
      price: price.toFixed(2),
      delta: delta.toFixed(4),
      gamma: gamma.toFixed(4),
      vega: vega.toFixed(4),
      theta: theta.toFixed(4),
      deltaWarning,
      gammaWarning
    }
  }
  
  const getPositionSize = (vol: number) => {
    if (vol < 20) return {regime: 'COMPRESSED', size: 200, color: '#4CAF50'}
    if (vol < 35) return {regime: 'NORMAL', size: 100, color: '#2196F3'}
    if (vol < 50) return {regime: 'ELEVATED', size: 50, color: '#FF9800'}
    return {regime: 'EXTREME', size: 25, color: '#F44336'}
  }
  
  const calculateBacktest = (prices: number[], window: number = 30) => {
    let portfolio = 100, maxDrawdown = 0, peakValue = 100, chartData = [], dailyReturns = [], profitableDays = 0, totalDays = 0, grossProfit = 0, grossLoss = 0
    
    for (let i = window; i < prices.length; i++) {
      const windowPrices = prices.slice(i - window, i)
      const returns = windowPrices.slice(1).map((p, idx) => Math.log(p / windowPrices[idx]))
      const mean = returns.reduce((a, b) => a + b) / returns.length
      const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2)) / returns.length
      const vol = Math.sqrt(variance) * Math.sqrt(252)
      const posSize = getPositionSize(vol * 100).size / 100
      const dailyReturn = Math.log(prices[i] / prices[i-1])
      const dailyPnL = dailyReturn * posSize
      portfolio *= Math.exp(dailyPnL)
      dailyReturns.push(dailyPnL)
      totalDays++
      if (dailyPnL > 0) { profitableDays++; grossProfit += dailyPnL } else { grossLoss += Math.abs(dailyPnL) }
      peakValue = Math.max(peakValue, portfolio)
      const drawdown = (peakValue - portfolio) / peakValue
      maxDrawdown = Math.max(maxDrawdown, drawdown)
      if (i % 30 === 0) chartData.push({ day: i, strategy: parseFloat(portfolio.toFixed(2)), buyHold: parseFloat((prices[i] / prices[0] * 100).toFixed(2)), vol: parseFloat((vol * 100).toFixed(2)) })
    }
    
    const avgReturn = dailyReturns.reduce((a, b) => a + b) / dailyReturns.length
    const returnVariance = dailyReturns.reduce((a, b) => a + Math.pow(b - avgReturn, 2)) / dailyReturns.length
    const returnStdDev = Math.sqrt(returnVariance)
    const sharpeRatio = ((avgReturn - 0.02/252) / returnStdDev) * Math.sqrt(252)
    const downsideReturns = dailyReturns.filter(r => r < 0)
    const downsideVariance = downsideReturns.length > 0 ? downsideReturns.reduce((a, b) => a + Math.pow(b, 2)) / downsideReturns.length : 0
    const downsideStdDev = Math.sqrt(downsideVariance)
    const sortinoRatio = downsideStdDev > 0 ? ((avgReturn - 0.02/252) / downsideStdDev) * Math.sqrt(252) : 0
    const calmarRatio = maxDrawdown > 0 ? (((portfolio / 100) - 1) * 100) / (maxDrawdown * 100) : 0
    const winRate = ((profitableDays / totalDays) * 100).toFixed(1)
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : '0')
    
    // Information Ratio (vs benchmark)
    const benchmarkReturns = []
    for (let i = window + 1; i < prices.length; i++) {
      benchmarkReturns.push(Math.log(prices[i] / prices[i-1]))
    }
    const avgBenchmarkReturn = benchmarkReturns.reduce((a, b) => a + b) / benchmarkReturns.length
    const excessReturns = dailyReturns.map((r, i) => r - benchmarkReturns[i])
    const avgExcessReturn = excessReturns.reduce((a, b) => a + b) / excessReturns.length
    const trackingError = Math.sqrt(excessReturns.reduce((a, b) => a + Math.pow(b - avgExcessReturn, 2), 0) / excessReturns.length)
    const informationRatio = trackingError > 0 ? (avgExcessReturn / trackingError) * Math.sqrt(252) : 0
    
    // Omega Ratio (threshold = 0)
    const gains = dailyReturns.filter(r => r > 0).reduce((a, b) => a + b, 0)
    const losses = Math.abs(dailyReturns.filter(r => r < 0).reduce((a, b) => a + b, 0))
    const omegaRatio = losses > 0 ? gains / losses : (gains > 0 ? 999 : 0)
    
    // Maximum Adverse Excursion (MAE) & Maximum Favorable Excursion (MFE)
    let mae = 0, mfe = 0, tradeCount = 0
    for (let i = window; i < prices.length - 5; i += 5) {
      const entryPrice = prices[i]
      const exitWindow = prices.slice(i, i + 5)
      const maxGain = Math.max(...exitWindow.map(p => (p - entryPrice) / entryPrice))
      const maxLoss = Math.min(...exitWindow.map(p => (p - entryPrice) / entryPrice))
      mae += Math.abs(maxLoss)
      mfe += maxGain
      tradeCount++
    }
    mae = tradeCount > 0 ? (mae / tradeCount) * 100 : 0
    mfe = tradeCount > 0 ? (mfe / tradeCount) * 100 : 0
    
    return { finalReturn: (((portfolio / 100) - 1) * 100).toFixed(2), maxDD: (maxDrawdown * 100).toFixed(2), buyHold: (((prices[prices.length - 1] / prices[0]) - 1) * 100).toFixed(2), sharpeRatio: sharpeRatio.toFixed(2), sortinoRatio: sortinoRatio.toFixed(2), calmarRatio: calmarRatio.toFixed(2), informationRatio: informationRatio.toFixed(2), omegaRatio: omegaRatio.toFixed(2), mae: mae.toFixed(2), mfe: mfe.toFixed(2), winRate, profitFactor, chartData }
  }
  
  const getRollingVolChart = (prices: number[], window: number = 30) => {
    let chartData = []
    for (let i = window; i < prices.length; i += 10) {
      const windowPrices = prices.slice(i - window, i)
      const returns = windowPrices.slice(1).map((p, idx) => Math.log(p / windowPrices[idx]))
      const mean = returns.reduce((a, b) => a + b) / returns.length
      const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2)) / returns.length
      const vol = Math.sqrt(variance) * Math.sqrt(252) * 100
      chartData.push({ day: i, volatility: parseFloat(vol.toFixed(2)) })
    }
    return chartData
  }
  
  
  const analyzePatterns = (results: any, mockData: any) => {
    const tickers = Object.keys(mockData)
    
    // Calculate correlations between all ticker pairs
    const correlations: any = {}
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const t1 = tickers[i]
        const t2 = tickers[j]
        const prices1 = mockData[t1].prices
        const prices2 = mockData[t2].prices
        
        const returns1 = prices1.slice(1).map((p: number, idx: number) => Math.log(p / prices1[idx]))
        const returns2 = prices2.slice(1).map((p: number, idx: number) => Math.log(p / prices2[idx]))
        
        const mean1 = returns1.reduce((a: number, b: number) => a + b) / returns1.length
        const mean2 = returns2.reduce((a: number, b: number) => a + b) / returns2.length
        
        const covariance = returns1.reduce((a: number, r: number, idx: number) => a + (r - mean1) * (returns2[idx] - mean2), 0) / returns1.length
        const var1 = returns1.reduce((a: number, r: number) => a + Math.pow(r - mean1, 2), 0) / returns1.length
        const var2 = returns2.reduce((a: number, r: number) => a + Math.pow(r - mean2, 2), 0) / returns2.length
        
        const corr = covariance / Math.sqrt(var1 * var2)
        correlations[`${t1}-${t2}`] = corr
      }
    }
    
    // Detect volatility coupling (when vol spikes correlate)
    const volCoupling: any = {}
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const t1 = tickers[i]
        const t2 = tickers[j]
        const prices1 = mockData[t1].prices
        const prices2 = mockData[t2].prices
        
        // Check 60-day rolling volatility correlation
        let volCorrelations = []
        for (let k = 60; k < Math.min(prices1.length, prices2.length); k += 30) {
          const window1 = prices1.slice(k - 60, k)
          const window2 = prices2.slice(k - 60, k)
          
          const ret1 = window1.slice(1).map((p, idx) => Math.log(p / window1[idx]))
          const ret2 = window2.slice(1).map((p, idx) => Math.log(p / window2[idx]))
          
          const vol1 = Math.sqrt(ret1.reduce((a, b) => a + Math.pow(b, 2)) / ret1.length) * Math.sqrt(252)
          const vol2 = Math.sqrt(ret2.reduce((a, b) => a + Math.pow(b, 2)) / ret2.length) * Math.sqrt(252)
          
          volCorrelations.push({v1: vol1, v2: vol2})
        }
        
        const volCov = volCorrelations.reduce((a, {v1, v2}) => a + (v1 - volCorrelations.reduce((av) => av + v1) / volCorrelations.length) * (v2 - volCorrelations.reduce((av) => av + v2) / volCorrelations.length), 0) / volCorrelations.length
        const volVar1 = volCorrelations.reduce((a, {v1}) => a + Math.pow(v1 - volCorrelations.reduce((av) => av + v1) / volCorrelations.length, 2), 0) / volCorrelations.length
        const volVar2 = volCorrelations.reduce((a, {v2}) => a + Math.pow(v2 - volCorrelations.reduce((av) => av + v2) / volCorrelations.length, 2), 0) / volCorrelations.length
        
        const volCorr = volCov / Math.sqrt(volVar1 * volVar2)
        volCoupling[`${t1}-${t2}`] = isNaN(volCorr) ? 0 : volCorr
      }
    }
    
    // Detect lead/lag patterns (which ticker moves first)
    const leadLag: any = {}
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const t1 = tickers[i]
        const t2 = tickers[j]
        const prices1 = mockData[t1].prices
        const prices2 = mockData[t2].prices
        
        const returns1 = prices1.slice(1).map((p: number, idx: number) => Math.log(p / prices1[idx]))
        const returns2 = prices2.slice(1).map((p: number, idx: number) => Math.log(p / prices2[idx]))
        
        // Check if t1 moving predicts t2 movement (next day)
        let leadCount = 0
        for (let k = 0; k < Math.min(returns1.length - 1, returns2.length - 1); k++) {
          if ((returns1[k] > 0 && returns2[k + 1] > 0) || (returns1[k] < 0 && returns2[k + 1] < 0)) {
            leadCount++
          }
        }
        const leadStrength = (leadCount / (Math.min(returns1.length - 1, returns2.length - 1))) - 0.5
        leadLag[`${t1}→${t2}`] = leadStrength
      }
    }
    
    // Calculate advanced quant metrics for each ticker
    const advancedMetrics: any = {}
    tickers.forEach(ticker => {
      const prices = mockData[ticker].prices
      const returns = prices.slice(1).map((p: number, idx: number) => Math.log(p / prices[idx]))
      
      const mean = returns.reduce((a, b) => a + b) / returns.length
      const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2)) / returns.length
      const stdDev = Math.sqrt(variance)
      
      // Skewness
      const skewness = returns.reduce((a, r) => a + Math.pow((r - mean) / stdDev, 3), 0) / returns.length
      
      // Kurtosis
      const kurtosis = returns.reduce((a, r) => a + Math.pow((r - mean) / stdDev, 4), 0) / returns.length - 3
      
      // Autocorrelation (1-day lag)
      const lagged = returns.slice(0, -1)
      const current = returns.slice(1)
      const laggedMean = lagged.reduce((a, b) => a + b) / lagged.length
      const currentMean = current.reduce((a, b) => a + b) / current.length
      const autocov = lagged.reduce((a, r, i) => a + (r - laggedMean) * (current[i] - currentMean), 0) / lagged.length
      const laggVar = lagged.reduce((a, r) => a + Math.pow(r - laggedMean, 2), 0) / lagged.length
      const currVar = current.reduce((a, r) => a + Math.pow(r - currentMean, 2), 0) / current.length
      const autocorr = autocov / Math.sqrt(laggVar * currVar)
      
      // Max consecutive wins/losses
      let maxWins = 0, maxLosses = 0, currWins = 0, currLosses = 0
      returns.forEach(r => {
        if (r > 0) {
          currWins++; currLosses = 0
          maxWins = Math.max(maxWins, currWins)
        } else {
          currLosses++; currWins = 0
          maxLosses = Math.max(maxLosses, currLosses)
        }
      })
      
      // Value at Risk (95% confidence)
      const sortedReturns = [...returns].sort((a, b) => a - b)
      const varIndex = Math.floor(sortedReturns.length * 0.05)
      const var95 = Math.abs(sortedReturns[varIndex])
      
      // Conditional Value at Risk (CVaR) - average of worst 5%
      const cvarIndex = Math.floor(sortedReturns.length * 0.05)
      const cvar = sortedReturns.slice(0, cvarIndex + 1).reduce((a, b) => a + b) / (cvarIndex + 1)
      
      // Volatility clustering (correlation of squared returns)
      const squaredReturns = returns.map(r => Math.pow(r, 2))
      const sqLagged = squaredReturns.slice(0, -1)
      const sqCurrent = squaredReturns.slice(1)
      const sqLagMean = sqLagged.reduce((a, b) => a + b) / sqLagged.length
      const sqCurrMean = sqCurrent.reduce((a, b) => a + b) / sqCurrent.length
      const sqAutocov = sqLagged.reduce((a, r, i) => a + (r - sqLagMean) * (sqCurrent[i] - sqCurrMean), 0) / sqLagged.length
      const sqLagVar = sqLagged.reduce((a, r) => a + Math.pow(r - sqLagMean, 2), 0) / sqLagged.length
      const sqCurrVar = sqCurrent.reduce((a, r) => a + Math.pow(r - sqCurrMean, 2), 0) / sqCurrent.length
      const volClustering = sqAutocov / Math.sqrt(sqLagVar * sqCurrVar)
      
      // Kelly Criterion sizing
      const winRate = returns.filter(r => r > 0).length / returns.length
      const avgWin = returns.filter(r => r > 0).reduce((a, b) => a + b, 0) / Math.max(1, returns.filter(r => r > 0).length)
      const avgLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0) / Math.max(1, returns.filter(r => r < 0).length))
      const kellyFraction = avgLoss > 0 ? (winRate * avgWin - (1 - winRate) * avgLoss) / avgLoss : 0
      const kellyPercent = Math.max(0, Math.min(0.25, kellyFraction * 100)) // Cap at 25%
      
      // Risk of Ruin (simplified)
      const riskOfRuin = Math.pow(((1 - winRate) / (winRate || 0.001)), 5)
      
      advancedMetrics[ticker] = {
        skewness: skewness.toFixed(3),
        kurtosis: kurtosis.toFixed(3),
        autocorr: autocorr.toFixed(3),
        maxWins,
        maxLosses,
        var95: (var95 * 100).toFixed(3),
        cvar: (cvar * 100).toFixed(3),
        volClustering: volClustering.toFixed(3),
        kellyPercent: kellyPercent.toFixed(2),
        riskOfRuin: Math.min(99.9, riskOfRuin * 100).toFixed(1)
      }
    })
    
    // Find strongest patterns
    const correlationSorted = Object.entries(correlations).sort((a: any, b: any) => Math.abs(b[1]) - Math.abs(a[1]))
    const volCouplingStrong = Object.entries(volCoupling).filter((e: any) => Math.abs(e[1]) > 0.3).sort((a: any, b: any) => Math.abs(b[1]) - Math.abs(a[1]))
    const leadLagStrong = Object.entries(leadLag).filter((e: any) => Math.abs(e[1]) > 0.02).sort((a: any, b: any) => Math.abs(b[1]) - Math.abs(a[1]))
    
    setPatterns({
      correlations: Object.fromEntries(correlationSorted.slice(0, 6)),
      volCoupling: Object.fromEntries(volCouplingStrong.slice(0, 3)),
      leadLag: Object.fromEntries(leadLagStrong.slice(0, 3)),
      advancedMetrics,
      summary: {
        highestCorr: correlationSorted[0],
        strongestVolCoupling: volCouplingStrong[0],
        strongestLead: leadLagStrong[0]
      }
    })
  }
  
  // Helper function to render Greeks with trend indicators
  const renderGreeksDisplay = (position: any, posKey: string) => {
    const currentPrice = metrics?.SOXL?.currentPrice ? parseFloat(metrics.SOXL.currentPrice) : 50
    const vol = metrics?.SOXL?.annVol ? parseFloat(metrics.SOXL.annVol) : 35
    const greeks = calculateOptionsGreeks(currentPrice, position.strike, position.dte, vol, 0.05, position.type === 'CC' ? 'call' : 'put')
    
    // Calculate trend indicators based on DTE and position
    const deltaTrend = position.dte < 15 ? '📈' : position.dte > 45 ? '📉' : '→'
    const thetaTrend = position.dte < 15 ? '📈' : '→'
    
    return (
      <div style={{marginTop: '10px', padding: '10px', background: greeks.deltaWarning || greeks.gammaWarning ? '#fff3cd' : '#e7f3ff', borderRadius: '6px', border: `2px solid ${greeks.deltaWarning || greeks.gammaWarning ? '#FF9800' : '#2196F3'}`}}>
        <p style={{margin: '0 0 8px 0', fontSize: '11px', fontWeight: 'bold', color: '#495057'}}>📊 Options Greeks (Black-Scholes)</p>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', fontSize: '10px'}}>
          <div>
            <span style={{color: '#6c757d'}}>Δ Delta:</span>
            <span style={{fontWeight: 'bold', marginLeft: '4px', color: greeks.deltaWarning ? '#F44336' : '#333'}}>{greeks.delta}</span>
            <span style={{marginLeft: '3px', fontSize: '9px'}}>{deltaTrend}</span>
          </div>
          <div>
            <span style={{color: '#6c757d'}}>Γ Gamma:</span>
            <span style={{fontWeight: 'bold', marginLeft: '4px', color: greeks.gammaWarning ? '#F44336' : '#333'}}>{greeks.gamma}</span>
          </div>
          <div>
            <span style={{color: '#6c757d'}}>V Vega:</span>
            <span style={{fontWeight: 'bold', marginLeft: '4px', color: '#333'}}>{greeks.vega}</span>
          </div>
          <div>
            <span style={{color: '#6c757d'}}>Θ Theta:</span>
            <span style={{fontWeight: 'bold', marginLeft: '4px', color: '#333'}}>{greeks.theta}</span>
            <span style={{marginLeft: '3px', fontSize: '9px'}}>{thetaTrend}</span>
          </div>
        </div>
        {(greeks.deltaWarning || greeks.gammaWarning) && (
          <p style={{margin: '6px 0 0 0', fontSize: '9px', color: '#F57C00', fontWeight: 'bold'}}>
            {greeks.deltaWarning && '⚠️ High assignment risk (Δ>0.7) '}
            {greeks.gammaWarning && '⚠️ High gamma - explosive potential '}
          </p>
        )}
        <p style={{margin: '6px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic'}}>
          Trend: 📈 Rising (DTE&lt;15) | 📉 Falling (DTE&gt;45) | → Stable
        </p>
      </div>
    )
  }

  useEffect(() => {
    loadData()
    
    // Auto-refresh every 30 seconds during market hours (9:30 AM - 4:00 PM ET)
    const refreshInterval = setInterval(() => {
      const now = new Date()
      const hours = now.getHours()
      const minutes = now.getMinutes()
      const currentTime = hours * 60 + minutes
      
      // Market hours: 9:30 AM = 570 min, 4:00 PM = 960 min (Eastern Time)
      // Adjust for your timezone if needed
      const marketOpen = 570  // 9:30 AM
      const marketClose = 960 // 4:00 PM
      
      if (currentTime >= marketOpen && currentTime <= marketClose) {
        console.log('🔄 Auto-refreshing market data...')
        loadData()
      }
    }, 30000) // 30 seconds
    
    return () => clearInterval(refreshInterval)
  }, [])
  
  // Load options chain when ticker changes
  useEffect(() => {
    const loadOptions = async () => {
      console.log(`🔄 Loading options for ${optionalTicker}...`)
      setLoadingOptions(true)
      const expirations = await fetchOptionsExpirations(optionalTicker)
      console.log(`📅 Found ${expirations.length} expirations:`, expirations)
      setOptionsExpirations(expirations)
      
      if (expirations.length > 0) {
        // Default to first expiration (nearest)
        setSelectedExpiration(expirations[0])
        const chainData = await fetchOptionsChain(optionalTicker, expirations[0])
        console.log(`📊 Options chain data loaded:`, chainData)
        setOptionsChainData(chainData)
      }
      
      setLoadingOptions(false)
    }
    
    if (optionalTicker) {
      loadOptions()
    }
  }, [optionalTicker])
  
  // Reload options chain when expiration changes
  useEffect(() => {
    const loadChainData = async () => {
      if (selectedExpiration && optionalTicker) {
        setLoadingOptions(true)
        const chainData = await fetchOptionsChain(optionalTicker, selectedExpiration)
        setOptionsChainData(chainData)
        setLoadingOptions(false)
      }
    }
    
    if (selectedExpiration) {
      loadChainData()
    }
  }, [selectedExpiration])

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    }}>
      <div style={{
        maxWidth: '1600px',
        margin: '0 auto',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        borderRadius: '20px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
          padding: '30px',
          color: 'white',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <h1 style={{margin: '0 0 10px 0', fontSize: '36px', fontWeight: '700'}}>🚀 Elite Quant Analytics</h1>
            <p style={{margin: 0, fontSize: '16px', opacity: 0.9}}>Institutional-Grade Market Intelligence & Risk Management</p>
            {lastUpdated && (
              <p style={{margin: '8px 0 0 0', fontSize: '13px', opacity: 0.75, fontStyle: 'italic'}}>
                📊 Data last refreshed: {lastUpdated}
              </p>
            )}
          </div>
          <div style={{display: 'flex', gap: '15px'}}>
            <button 
              onClick={exportWatchlistCSV}
              style={{
                padding: '15px 30px',
                background: 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                fontWeight: 'bold',
                fontSize: '16px',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                transition: 'transform 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '10px'
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
            >
              <span style={{fontSize: '20px'}}>📊</span> Export Watchlist
            </button>
            <button 
              onClick={generatePDFReport}
              style={{
                padding: '15px 30px',
                background: 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                fontWeight: 'bold',
                fontSize: '16px',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                transition: 'transform 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '10px'
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
            >
              <span style={{fontSize: '20px'}}>📄</span> Generate PDF Report
            </button>
          </div>
        </div>
        
        <div style={{padding: '30px'}}>
        
        {/* Alert System Panel */}
        {alerts.length > 0 && (
          <div style={{
            marginBottom: '20px',
            padding: '20px',
            background: 'linear-gradient(135deg, #fff5f5 0%, #ffe0e0 100%)',
            borderRadius: '12px',
            border: '3px solid #F44336',
            boxShadow: '0 8px 16px rgba(244,67,54,0.2)'
          }}>
            <h3 style={{margin: '0 0 15px 0', fontSize: '18px', fontWeight: '700', color: '#C62828', display: 'flex', alignItems: 'center', gap: '10px'}}>
              <span style={{fontSize: '24px'}}>🚨</span> Active Alerts ({alerts.length})
            </h3>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px'}}>
              {alerts.map((alert, idx) => (
                <div key={idx} style={{
                  padding: '12px 16px',
                  background: 'white',
                  borderRadius: '8px',
                  borderLeft: `4px solid ${alert.color}`,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '6px'}}>
                    <span style={{fontWeight: 'bold', fontSize: '12px', color: alert.color, textTransform: 'uppercase'}}>
                      {alert.severity}
                    </span>
                    <span style={{fontSize: '10px', color: '#999'}}>{alert.symbol}</span>
                  </div>
                  <p style={{margin: '0 0 6px 0', fontSize: '13px', color: '#333', lineHeight: '1.4'}}>{alert.message}</p>
                  <p style={{margin: 0, fontSize: '10px', color: '#666', fontStyle: 'italic'}}>{alert.timestamp}</p>
                </div>
              ))}
            </div>
            <p style={{margin: '15px 0 0 0', fontSize: '11px', color: '#666', fontStyle: 'italic', textAlign: 'center'}}>
              💡 Alerts are checked on each data refresh. Connect Telegram/Email webhook for real-time notifications.
            </p>
          </div>
        )}
        
        {/* Alert History Log */}
        {alertHistory.length > 0 && (
          <div style={{
            marginBottom: '20px',
            padding: '20px',
            background: 'linear-gradient(135deg, #f5f5f5 0%, #eeeeee 100%)',
            borderRadius: '12px',
            border: '2px solid #9E9E9E',
            boxShadow: '0 4px 8px rgba(0,0,0,0.1)'
          }}>
            <h3 style={{margin: '0 0 15px 0', fontSize: '16px', fontWeight: '700', color: '#424242', display: 'flex', alignItems: 'center', gap: '10px'}}>
              <span style={{fontSize: '20px'}}>📜</span> Alert History ({alertHistory.length})
            </h3>
            <div style={{
              maxHeight: '400px',
              overflowY: 'auto',
              background: 'white',
              borderRadius: '8px',
              border: '1px solid #ddd'
            }}>
              <table style={{width: '100%', borderCollapse: 'collapse'}}>
                <thead style={{position: 'sticky', top: 0, background: '#f9f9f9', borderBottom: '2px solid #ddd'}}>
                  <tr>
                    <th style={{padding: '12px', textAlign: 'left', fontSize: '11px', fontWeight: 'bold', color: '#666', width: '140px'}}>TIMESTAMP</th>
                    <th style={{padding: '12px', textAlign: 'left', fontSize: '11px', fontWeight: 'bold', color: '#666', width: '80px'}}>SYMBOL</th>
                    <th style={{padding: '12px', textAlign: 'left', fontSize: '11px', fontWeight: 'bold', color: '#666', width: '100px'}}>TYPE</th>
                    <th style={{padding: '12px', textAlign: 'left', fontSize: '11px', fontWeight: 'bold', color: '#666'}}>MESSAGE</th>
                  </tr>
                </thead>
                <tbody>
                  {alertHistory.map((alert, idx) => (
                    <tr key={idx} style={{
                      borderBottom: '1px solid #f0f0f0',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f8f8f8'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'white'}>
                      <td style={{padding: '10px 12px', fontSize: '11px', color: '#666', fontFamily: 'monospace'}}>
                        {alert.timestamp}
                      </td>
                      <td style={{padding: '10px 12px', fontSize: '12px', fontWeight: 'bold', color: '#333'}}>
                        {alert.symbol}
                      </td>
                      <td style={{padding: '10px 12px'}}>
                        <span style={{
                          fontSize: '10px',
                          fontWeight: 'bold',
                          padding: '3px 8px',
                          borderRadius: '12px',
                          background: alert.color + '20',
                          color: alert.color,
                          textTransform: 'uppercase'
                        }}>
                          {alert.type.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{padding: '10px 12px', fontSize: '12px', color: '#555', lineHeight: '1.4'}}>
                        {alert.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{margin: '12px 0 0 0', fontSize: '10px', color: '#999', fontStyle: 'italic', textAlign: 'center'}}>
              Showing last {alertHistory.length} alert(s) · History limited to 50 most recent
            </p>
          </div>
        )}
      
        <div style={{
          marginBottom: '30px',
          display: 'flex',
          gap: '15px',
          alignItems: 'center',
          padding: '20px',
          background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
          borderRadius: '12px',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <div style={{flex: 1}}>
            <label style={{display: 'block', marginBottom: '8px', fontWeight: '600', color: '#2c3e50', fontSize: '14px'}}>📊 Ticker Symbol:</label>
            <input 
              type="text" 
              value={optionalTicker} 
              onChange={(e) => setOptionalTicker(e.target.value.toUpperCase())} 
              placeholder="e.g., AAPL, TSLA, NVDA"
              style={{
                width: '100%',
                padding: '12px 16px',
                fontSize: '16px',
                border: '2px solid #e0e0e0',
                borderRadius: '8px',
                outline: 'none',
                transition: 'all 0.3s',
                fontWeight: '500'
              }}
              onFocus={(e) => e.target.style.borderColor = '#667eea'}
              onBlur={(e) => e.target.style.borderColor = '#e0e0e0'}
            />
          </div>
          <div>
            <label style={{display: 'block', marginBottom: '8px', opacity: 0}}>&nbsp;</label>
            <button 
              onClick={loadData} 
              disabled={loading}
              style={{
                padding: '12px 30px',
                fontSize: '16px',
                fontWeight: '600',
                background: loading ? '#95a5a6' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 15px rgba(102, 126, 234, 0.4)',
                transition: 'all 0.3s',
                minWidth: '160px'
              }}
              onMouseOver={(e) => !loading && (e.currentTarget.style.transform = 'translateY(-2px)')}
              onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(0)'}
            >
              {loading ? '⏳ Loading...' : '🔄 Analyze'}
            </button>
          </div>
        </div>
      
        {error && (
          <div style={{
            marginBottom: '20px',
            padding: '15px 20px',
            background: '#fee',
            border: '2px solid #fcc',
            borderRadius: '8px',
            color: '#c33',
            fontWeight: '500'
          }}>
            ⚠️ Error: {error}
          </div>
        )}
      
        {patterns && (
          <div style={{
            marginBottom: '30px',
            background: 'white',
            borderRadius: '16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            overflow: 'hidden',
            border: '1px solid #e0e0e0'
          }}>
            <div style={{
              padding: '20px 25px',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              borderBottom: '1px solid #e0e0e0'
            }}>
              <h2 style={{margin: 0, color: 'white', fontSize: '24px', fontWeight: '600'}}>🔍 Cross-Asset Pattern Analysis</h2>
            </div>
            <div style={{padding: '25px', background: 'rgba(255,255,255,0.95)'}}>
          
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '25px'}}>
              {/* Correlations */}
              <div style={{
                background: 'linear-gradient(135deg, #fff 0%, #f8f9fa 100%)',
                padding: '20px',
                borderRadius: '12px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                border: '1px solid #e9ecef'
              }}>
                <h4 style={{margin: '0 0 15px 0', fontSize: '16px', fontWeight: '600', color: '#2c3e50'}}>📊 Price Correlations</h4>
              {Object.entries(patterns.correlations).map(([pair, corr]: [string, any]) => (
                <div key={pair} style={{marginBottom: '8px', fontSize: '12px', display: 'flex', justifyContent: 'space-between'}}>
                  <span style={{color: '#333'}}>{pair}</span>
                  <span style={{
                    fontWeight: 'bold',
                    color: corr > 0.7 ? '#4CAF50' : corr > 0.3 ? '#2196F3' : corr > -0.3 ? '#FF9800' : '#F44336'
                  }}>
                    {(corr as number).toFixed(3)}
                  </span>
                </div>
              ))}
            </div>
            
            {/* Volatility Coupling */}
            <div style={{backgroundColor: '#f8f9fa', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #dee2e6'}}>
              <h4 style={{margin: '0 0 10px 0', fontSize: '13px', color: '#495057'}}>Volatility Coupling</h4>
              {Object.entries(patterns.volCoupling).length > 0 ? (
                Object.entries(patterns.volCoupling).map(([pair, corr]: [string, any]) => (
                  <div key={pair} style={{marginBottom: '8px', fontSize: '12px', display: 'flex', justifyContent: 'space-between'}}>
                    <span style={{color: '#333'}}>{pair}</span>
                    <span style={{fontWeight: 'bold', color: '#FF9800'}}>
                      {(corr as number).toFixed(3)}
                    </span>
                  </div>
                ))
              ) : (
                <p style={{fontSize: '12px', color: '#999'}}>No strong coupling detected</p>
              )}
            </div>
            
            {/* Lead/Lag Patterns */}
            <div style={{backgroundColor: '#f8f9fa', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #dee2e6'}}>
              <h4 style={{margin: '0 0 10px 0', fontSize: '13px', color: '#495057', fontWeight: 'bold'}}>Lead/Lag Signals</h4>
              {Object.entries(patterns.leadLag).length > 0 ? (
                Object.entries(patterns.leadLag).map(([pair, strength]: [string, any]) => (
                  <div key={pair} style={{marginBottom: '8px', fontSize: '12px', display: 'flex', justifyContent: 'space-between'}}>
                    <span style={{color: '#333'}}>{pair}</span>
                    <span style={{fontWeight: 'bold', color: strength > 0 ? '#4CAF50' : '#F44336'}}>
                      {((strength as number) * 100).toFixed(1)}%
                    </span>
                  </div>
                ))
              ) : (
                <p style={{fontSize: '12px', color: '#999'}}>No lead signals detected</p>
              )}
            </div>
          </div>
          
          {patterns.summary.highestCorr && (
            <div style={{marginTop: '12px', padding: '10px', backgroundColor: '#fff9c4', borderRadius: '4px', fontSize: '12px', color: '#333'}}>
              <strong>Key Insight:</strong> {(patterns.summary.highestCorr[0] as string).split('-').join(' & ')} show the strongest correlation ({((patterns.summary.highestCorr[1] as number) * 100).toFixed(1)}%)
            </div>
          )}
          
          {/* Advanced Quant Metrics */}
          <div style={{marginTop: '20px', borderTop: '2px solid #ccc', paddingTop: '15px', background: 'rgba(255,255,255,0.95)', padding: '20px', borderRadius: '12px'}}>
            <h3 style={{margin: '0 0 15px 0', color: '#1565C0', fontWeight: 'bold'}}>📊 Elite Quant Metrics & Sizing Calculator</h3>
            
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px'}}>
              {Object.entries(patterns.advancedMetrics).map(([ticker, metrics]: [string, any]) => (
                <div key={ticker} style={{backgroundColor: '#f8f9fa', padding: '12px', borderRadius: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #dee2e6'}}>
                  <h4 style={{margin: '0 0 10px 0', fontSize: '13px', color: '#1565C0', fontWeight: 'bold'}}>{ticker}</h4>
                  
                  <div style={{fontSize: '11px', marginBottom: '8px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Skewness</span>
                      <span style={{fontWeight: 'bold', color: (metrics.skewness as any) < -0.3 ? '#F44336' : (metrics.skewness as any) > 0.3 ? '#4CAF50' : '#FF9800'}}>
                        {metrics.skewness}
                      </span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Kurtosis</span>
                      <span style={{fontWeight: 'bold', color: (metrics.kurtosis as any) > 1 ? '#F44336' : '#2196F3'}}>
                        {metrics.kurtosis}
                      </span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Autocorr (lag-1)</span>
                      <span style={{fontWeight: 'bold', color: Math.abs(parseFloat(metrics.autocorr as string)) > 0.1 ? '#FF9800' : '#4CAF50'}}>
                        {metrics.autocorr}
                      </span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Max Win Streak</span>
                      <span style={{fontWeight: 'bold', color: '#4CAF50'}}>{metrics.maxWins}</span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Max Loss Streak</span>
                      <span style={{fontWeight: 'bold', color: '#F44336'}}>{metrics.maxLosses}</span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px', borderBottom: '1px solid #eee', paddingBottom: '4px'}}>
                      <span style={{color: '#333'}}>VaR (95%)</span>
                      <span style={{fontWeight: 'bold', color: '#FF6B6B'}}>{metrics.var95}%</span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>CVaR</span>
                      <span style={{fontWeight: 'bold', color: '#D32F2F'}}>{metrics.cvar}%</span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '4px'}}>
                      <span style={{color: '#333'}}>Vol Clustering</span>
                      <span style={{fontWeight: 'bold', color: Math.abs(parseFloat(metrics.volClustering as string)) > 0.2 ? '#FF9800' : '#4CAF50'}}>
                        {metrics.volClustering}
                      </span>
                    </div>
                  </div>
                  
                  <div style={{backgroundColor: '#fff3e0', padding: '8px', borderRadius: '4px', marginTop: '10px', borderTop: '2px solid #FF9800'}}>
                    <div style={{fontSize: '11px', fontWeight: 'bold', color: '#E65100', marginBottom: '4px'}}>📐 KELLY SIZING</div>
                    <div style={{fontSize: '13px', fontWeight: 'bold', color: '#1565C0'}}>{metrics.kellyPercent}%</div>
                    <div style={{fontSize: '10px', color: '#666', marginTop: '4px'}}>
                      Risk of Ruin: <span style={{color: parseFloat(metrics.riskOfRuin as string) > 50 ? '#F44336' : '#4CAF50'}}>{metrics.riskOfRuin}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
            </div>
          </div>
        )}
        
        {metrics && (
          <div style={{marginTop: '10px'}}>
            {Object.entries(metrics).map(([symbol, m]: [string, any]) => (
              <div key={symbol} style={{
                marginBottom: '30px',
                background: 'white',
                borderRadius: '16px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                overflow: 'hidden',
                border: '1px solid #e0e0e0'
              }}>
                <div style={{
                  padding: '25px',
                  background: 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
                  borderBottom: '1px solid #e0e0e0'
                }}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                    <div>
                      <h2 style={{margin: '0 0 8px 0', color: 'white', fontSize: '28px', fontWeight: '700'}}>{symbol}</h2>
                      <p style={{margin: 0, fontSize: '14px', color: 'rgba(255,255,255,0.9)'}}>{m.description}</p>
                    </div>
                    {m.posSize && (
                      <div style={{
                        padding: '15px 25px',
                        background: m.posSize.color,
                        color: 'white',
                        borderRadius: '12px',
                        textAlign: 'center',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
                      }}>
                        <div style={{fontWeight: 'bold', fontSize: '18px', marginBottom: '5px'}}>{m.posSize.regime}</div>
                        <div style={{fontSize: '14px', opacity: 0.95}}>Size: {m.posSize.size}%</div>
                      </div>
                    )}
                  </div>
                </div>
                
                <div style={{padding: '25px'}}>
              
                {m.error ? (
                  <p style={{color: '#e74c3c', fontWeight: '500', padding: '20px', background: '#fee', borderRadius: '8px'}}>⚠️ {m.error}</p>
                ) : (
                  <>
                  {m.lastAdjClose && m.lastDate && (
                    <div style={{
                      marginBottom: '20px',
                      padding: '20px',
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      borderRadius: '12px',
                      color: 'white',
                      textAlign: 'center',
                      boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)'
                    }}>
                      <p style={{margin: '0 0 5px 0', fontSize: '13px', opacity: 0.9, fontWeight: '600'}}>📊 Last Adjusted Close</p>
                      <p style={{margin: '0 0 5px 0', fontSize: '32px', fontWeight: '700'}}>${m.lastAdjClose.toFixed(2)}</p>
                      <p style={{margin: 0, fontSize: '12px', opacity: 0.85}}>As of {m.lastDate}</p>
                    </div>
                  )}
                  
                  {m.technicals && m.regime && m.posSize && (() => {
                    const signal = generateTradingSignal(m.technicals, m.regime, m.posSize)
                    return (
                      <div style={{
                        marginBottom: '25px',
                        padding: '25px',
                        background: `linear-gradient(135deg, ${signal.color}15 0%, ${signal.color}25 100%)`,
                        borderRadius: '16px',
                        border: `3px solid ${signal.color}`,
                        boxShadow: `0 8px 24px ${signal.color}40`
                      }}>
                        <div style={{textAlign: 'center', marginBottom: '15px'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '14px', color: '#666', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px'}}>Quant Signal</p>
                          <p style={{margin: '0 0 8px 0', fontSize: '48px'}}>{signal.emoji}</p>
                          <p style={{margin: '0 0 5px 0', fontSize: '36px', fontWeight: '800', color: signal.color}}>{signal.action}</p>
                          <p style={{margin: 0, fontSize: '14px', fontWeight: '600', color: signal.color, opacity: 0.8}}>{signal.confidence} CONFIDENCE</p>
                        </div>
                        <div style={{marginTop: '15px', padding: '15px', background: 'rgba(255,255,255,0.7)', borderRadius: '8px'}}>
                          <p style={{margin: '0 0 8px 0', fontSize: '12px', fontWeight: '700', color: '#333'}}>Signal Breakdown:</p>
                          <div style={{display: 'flex', justifyContent: 'space-around', marginBottom: '10px'}}>
                            <div><span style={{color: '#4CAF50', fontWeight: 'bold'}}>Bullish: {signal.bullishSignals}</span></div>
                            <div><span style={{color: '#F44336', fontWeight: 'bold'}}>Bearish: {signal.bearishSignals}</span></div>
                            <div><span style={{color: '#2196F3', fontWeight: 'bold'}}>Net: {signal.netSignal}</span></div>
                          </div>
                          <div style={{fontSize: '11px', color: '#666', lineHeight: '1.6'}}>
                            {signal.reasons.map((reason: string, idx: number) => (
                              <div key={idx} style={{marginBottom: '3px'}}>• {reason}</div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  
                    <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px'}}>
                      <div style={{
                        background: 'linear-gradient(135deg, #f8f9fa 0%, #fff 100%)',
                        padding: '15px',
                        borderRadius: '10px',
                        border: '1px solid #e9ecef',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
                      }}>
                        <p style={{margin: '0 0 8px 0', fontSize: '12px', color: '#6c757d', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px'}}>Annual Volatility</p>
                        <p style={{margin: 0, fontSize: '22px', fontWeight: '700', color: '#2c3e50'}}>{m.annVol}%</p>
                      </div>
                      <div style={{
                        background: 'linear-gradient(135deg, #f8f9fa 0%, #fff 100%)',
                        padding: '15px',
                        borderRadius: '10px',
                        border: '1px solid #e9ecef',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
                      }}>
                        <p style={{margin: '0 0 8px 0', fontSize: '12px', color: '#6c757d', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px'}}>6-Month Return</p>
                      <p style={{margin: 0, fontSize: '18px', fontWeight: 'bold', color: parseFloat(m.totalReturn) >= 0 ? '#4CAF50' : '#F44336'}}>
                        {parseFloat(m.totalReturn) >= 0 ? '+' : ''}{m.totalReturn}%
                      </p>
                    </div>
                    <div style={{backgroundColor: '#f8f9fa', padding: '10px', borderRadius: '4px', border: '1px solid #e9ecef'}}>
                      <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Price Range</p>
                      <p style={{margin: 0, fontSize: '14px', color: '#333'}}>${m.startPrice} → ${m.currentPrice}</p>
                    </div>
                    <div style={{backgroundColor: '#f8f9fa', padding: '10px', borderRadius: '4px', border: '1px solid #e9ecef'}}>
                      <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Data Points</p>
                      <p style={{margin: 0, fontSize: '14px', color: '#333'}}>{m.dataPoints} days</p>
                    </div>
                    
                    {m.beta && (
                      <>
                        <div style={{backgroundColor: m.beta.leverageDecayAlert ? '#ffebee' : '#f8f9fa', padding: '10px', borderRadius: '4px', border: m.beta.leverageDecayAlert ? '2px solid #F44336' : '1px solid #e9ecef'}}>
                          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px'}}>
                            <p style={{margin: 0, fontSize: '12px', color: '#666'}}>Rolling Beta (vs SPY)</p>
                            {m.beta.leverageDecayAlert && (
                              <div style={{
                                padding: '3px 8px',
                                background: '#F44336',
                                color: 'white',
                                borderRadius: '12px',
                                fontSize: '9px',
                                fontWeight: 'bold',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px'
                              }}>
                                <span>⚠️</span> LEVERAGE DECAY
                              </div>
                            )}
                          </div>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.beta.leverageDecayAlert ? '#F44336' : '#333'}}>{m.beta.beta}</p>
                          {m.beta.leverageDecayAlert && (
                            <p style={{margin: '5px 0 0 0', fontSize: '10px', color: '#D32F2F', fontWeight: 'bold'}}>
                              {m.beta.consecutiveDaysBelow28} days below 2.8 - Consider SOXX
                            </p>
                          )}
                        </div>
                        <div style={{backgroundColor: '#f8f9fa', padding: '10px', borderRadius: '4px', border: '1px solid #e9ecef'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>95% CI</p>
                          <p style={{margin: 0, fontSize: '13px', color: '#333'}}>[{m.beta.ciLow}, {m.beta.ciHigh}]</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '11px', color: '#999'}}>SE: {m.beta.se}</p>
                        </div>
                      </>
                    )}
                    
                    {m.technicals && (
                      <>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>📈 RSI (14)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.technicals.rsi > 70 ? '#F44336' : m.technicals.rsi < 30 ? '#4CAF50' : '#FF9800'}}>{m.technicals.rsi.toFixed(1)}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#495057', fontWeight: 'bold'}}>{m.technicals.rsi > 70 ? '⚠️ OVERBOUGHT' : m.technicals.rsi < 30 ? '✓ OVERSOLD' : 'NEUTRAL'}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>Range: 0-100</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>{'↓ <30 = Buy | ↑ >70 = Sell'}</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>📊 MACD</p>
                          <p style={{margin: 0, fontSize: '13px'}}>
                            <span style={{fontWeight: 'bold', color: m.technicals.macdHistogram > 0 ? '#4CAF50' : '#F44336'}}>Line: {m.technicals.macd.toFixed(4)}</span>
                          </p>
                          <p style={{margin: '2px 0 0 0', fontSize: '11px', color: '#495057', fontWeight: 'bold'}}>Signal: {m.technicals.macdSignal.toFixed(4)}</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '10px', color: '#495057', fontWeight: 'bold'}}>Hist: {m.technicals.macdHistogram > 0 ? '↑' : '↓'} {Math.abs(m.technicals.macdHistogram).toFixed(4)}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>{m.technicals.macdRange}</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>{'↑ Hist > 0 = Buy | ↓ Hist < 0 = Sell'}</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>💨 PPO</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.technicals.ppo > 0 ? '#4CAF50' : '#F44336'}}>{m.technicals.ppo > 0 ? '+' : ''}{m.technicals.ppo.toFixed(2)}%</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#495057', fontWeight: 'bold'}}>{m.technicals.ppo > 0 ? 'BULLISH' : 'BEARISH'}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>Range: -10 to +10</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>% momentum indicator</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>📦 Volume Trend</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#2196F3'}}>{m.technicals.volumeTrend.toFixed(2)}%</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#495057', fontWeight: 'bold'}}>30-day rolling vol</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>Volatility proxy</p>
                        </div>
                        <div style={{backgroundColor: '#e3f2fd', padding: '10px', borderRadius: '4px', border: '2px solid #2196F3'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>🎯 Bollinger Bands</p>
                          <p style={{margin: 0, fontSize: '13px'}}>Position: <span style={{fontWeight: 'bold', color: m.technicals.bbPosition > 80 ? '#F44336' : m.technicals.bbPosition < 20 ? '#4CAF50' : '#FF9800'}}>{m.technicals.bbPosition.toFixed(0)}%</span></p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>Upper: ${m.technicals.bbUpper} | Lower: ${m.technicals.bbLower}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#999', fontStyle: 'italic'}}>{'↓ <10% = Buy | ↑ >90% = Sell'}</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>📐 CCI (20)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.technicals.cci > 100 ? '#F44336' : m.technicals.cci < -100 ? '#4CAF50' : '#FF9800'}}>{m.technicals.cci.toFixed(1)}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#495057', fontWeight: 'bold'}}>{m.technicals.cci > 100 ? '⚠️ OVERBOUGHT' : m.technicals.cci < -100 ? '✓ OVERSOLD' : 'NEUTRAL'}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>Range: ±200</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '9px', color: '#6c757d', fontStyle: 'italic', fontWeight: 'bold'}}>{'↓ <-100 = Buy | ↑ >100 = Sell'}</p>
                        </div>
                        <div style={{backgroundColor: '#e3f2fd', padding: '10px', borderRadius: '4px', border: '2px solid #2196F3'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>📏 ATR (14)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#FF5722'}}>{m.technicals.atrPercent.toFixed(2)}%</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>${m.technicals.atr.toFixed(2)} avg range</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#999', fontStyle: 'italic'}}>Stop-loss reference</p>
                        </div>
                        <div style={{backgroundColor: '#e3f2fd', padding: '10px', borderRadius: '4px', border: '2px solid #2196F3'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>🎲 Stochastic</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.technicals.stochastic > 80 ? '#F44336' : m.technicals.stochastic < 20 ? '#4CAF50' : '#FF9800'}}>{m.technicals.stochastic.toFixed(0)}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>{m.technicals.stochastic > 80 ? '⚠️ OVERBOUGHT' : m.technicals.stochastic < 20 ? '✓ OVERSOLD' : 'NEUTRAL'}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#999', fontStyle: 'italic'}}>{'↓ <20 = Buy | ↑ >80 = Sell'}</p>
                        </div>
                      </>
                    )}
                    
                    {m.regime && (
                      <>
                        <div style={{backgroundColor: m.regime.regime === 'BULL' ? '#c8e6c9' : m.regime.regime === 'BEAR' ? '#ffcccc' : '#fff9c4', padding: '10px', borderRadius: '4px', border: '2px solid ' + (m.regime.regime === 'BULL' ? '#4CAF50' : m.regime.regime === 'BEAR' ? '#F44336' : '#FF9800')}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>🎯 Regime</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.regime.regime === 'BULL' ? '#2E7D32' : m.regime.regime === 'BEAR' ? '#C62828' : '#F57F17'}}>
                            {m.regime.regime === 'BULL' ? '📈' : m.regime.regime === 'BEAR' ? '📉' : '↔️'} {m.regime.regime}
                          </p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>Strength: {m.regime.trendStrength}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '9px', color: '#999', fontStyle: 'italic'}}>BULL = Buy bias | BEAR = Sell bias</p>
                        </div>
                        <div style={{backgroundColor: '#f5f5f5', padding: '10px', borderRadius: '4px', border: '2px solid #2196F3'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#333', fontWeight: 'bold'}}>📍 SMA 50/200</p>
                          <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold'}}>50:</span> ${m.regime.sma50}</p>
                          <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold'}}>200:</span> ${m.regime.sma200}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: parseFloat(m.regime.sma50 as string) > parseFloat(m.regime.sma200 as string) ? '#4CAF50' : '#F44336'}}>
                            {parseFloat(m.regime.sma50 as string) > parseFloat(m.regime.sma200 as string) ? '✓ Golden Cross' : '✗ Death Cross'}
                          </p>
                        </div>
                        <div style={{backgroundColor: '#f5f5f5', padding: '10px', borderRadius: '4px', border: '2px solid #FF9800'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#333', fontWeight: 'bold'}}>🎪 Support/Resistance</p>
                          <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold'}}>R:</span> ${m.regime.resistance}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold'}}>S:</span> ${m.regime.support}</p>
                        </div>
                        <div style={{backgroundColor: m.regime.marketBehavior === 'MEAN_REVERTING' ? '#c8e6c9' : m.regime.marketBehavior === 'TRENDING' ? '#fff9c4' : '#f5f5f5', padding: '10px', borderRadius: '4px', border: '2px solid ' + (m.regime.marketBehavior === 'MEAN_REVERTING' ? '#4CAF50' : m.regime.marketBehavior === 'TRENDING' ? '#FF9800' : '#9E9E9E')}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>🔬 Hurst Exponent</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.regime.marketBehavior === 'MEAN_REVERTING' ? '#2E7D32' : m.regime.marketBehavior === 'TRENDING' ? '#F57F17' : '#616161'}}>{m.regime.hurstExponent}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>{m.regime.marketBehavior.replace('_', ' ')}</p>
                        </div>
                        <div style={{backgroundColor: m.regime.meanReversionSignal === 'OVERSOLD' ? '#c8e6c9' : m.regime.meanReversionSignal === 'OVERBOUGHT' ? '#ffcccc' : '#fff9c4', padding: '10px', borderRadius: '4px', border: '2px solid ' + (m.regime.meanReversionSignal === 'OVERSOLD' ? '#4CAF50' : m.regime.meanReversionSignal === 'OVERBOUGHT' ? '#F44336' : '#FF9800')}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>⚖️ Mean Reversion</p>
                          <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: m.regime.meanReversionSignal === 'OVERSOLD' ? '#4CAF50' : m.regime.meanReversionSignal === 'OVERBOUGHT' ? '#F44336' : '#FF9800'}}>
                            {m.regime.meanReversionSignal}
                          </p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>Z-score: {m.regime.zscore}</p>
                        </div>
                      </>
                    )}
                    
                    {m.vixCorrelation && (
                      <div style={{backgroundColor: m.vixCorrelation.signal === 'RISK_OFF' ? '#ffcccc' : m.vixCorrelation.signal === 'RISK_ON' ? '#c8e6c9' : '#f5f5f5', padding: '10px', borderRadius: '4px', border: '2px solid ' + (m.vixCorrelation.signal === 'RISK_OFF' ? '#F44336' : m.vixCorrelation.signal === 'RISK_ON' ? '#4CAF50' : '#9E9E9E')}}>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '5px'}}>
                          <p style={{margin: 0, fontSize: '12px', color: '#666', fontWeight: 'bold'}}>⚠️ VIX Correlation (60d)</p>
                          {m.vixCorrelation.severityScore !== undefined && (
                            <div style={{
                              padding: '3px 10px',
                              background: m.vixCorrelation.severityScore >= 7 ? '#F44336' : m.vixCorrelation.severityScore >= 4 ? '#FF9800' : m.vixCorrelation.severityScore >= 2 ? '#FFC107' : '#4CAF50',
                              color: 'white',
                              borderRadius: '12px',
                              fontSize: '10px',
                              fontWeight: 'bold',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}>
                              <span>Risk:</span> {m.vixCorrelation.severityScore.toFixed(1)}/10
                            </div>
                          )}
                        </div>
                        <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.vixCorrelation.signal === 'RISK_OFF' ? '#C62828' : m.vixCorrelation.signal === 'RISK_ON' ? '#2E7D32' : '#616161'}}>{m.vixCorrelation.correlation}</p>
                        <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>{m.vixCorrelation.signal.replace('_', ' ')}</p>
                        {m.vixCorrelation.severityScore >= 7 && (
                          <p style={{margin: '5px 0 0 0', fontSize: '9px', color: '#D32F2F', fontWeight: 'bold'}}>
                            ⚠️ HIGH DECOUPLING RISK - VIX: {m.vixCorrelation.currentVIX}
                          </p>
                        )}
                      </div>
                    )}
                    
                    {m.options && (
                      <>
                        <div style={{backgroundColor: '#ede7f6', padding: '10px', borderRadius: '4px', border: '2px solid #673AB7'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#333', fontWeight: 'bold'}}>📊 Call Greeks (Black-Scholes)</p>
                          <div style={{fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', color: '#333'}}>
                            <div><span style={{color: '#666'}}>Δ:</span> <span style={{fontWeight: 'bold'}}>{m.options.callDelta}</span></div>
                            <div><span style={{color: '#666'}}>Θ:</span> <span style={{fontWeight: 'bold'}}>${m.options.callTheta}</span></div>
                            <div><span style={{color: '#666'}}>Ν:</span> <span style={{fontWeight: 'bold'}}>{m.options.callVega}</span></div>
                            <div><span style={{color: '#666'}}>Γ:</span> <span style={{fontWeight: 'bold'}}>{m.options.callGamma}</span></div>
                          </div>
                        </div>
                        <div style={{backgroundColor: '#ede7f6', padding: '10px', borderRadius: '4px', border: '2px solid #673AB7'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#333', fontWeight: 'bold'}}>💰 Option Prices</p>
                          <p style={{margin: '0 0 2px 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold', color: '#4CAF50'}}>Call:</span> ${m.options.callPrice}</p>
                          <p style={{margin: '2px 0 0 0', fontSize: '11px', color: '#333'}}><span style={{fontWeight: 'bold', color: '#F44336'}}>Put:</span> ${m.options.putPrice}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>ATM: ${m.options.atmStrike}</p>
                        </div>
                        <div style={{backgroundColor: '#ede7f6', padding: '10px', borderRadius: '4px', border: '2px solid #673AB7'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>📈 Implied Move</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#2196F3'}}>${m.options.impliedMove}</p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>{m.options.impliedMovePercent}% of spot</p>
                        </div>
                        <div style={{backgroundColor: '#ede7f6', padding: '10px', borderRadius: '4px', border: '2px solid #673AB7'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666', fontWeight: 'bold'}}>📊 Put/Call Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: m.options.putCallRatio > 1 ? '#F44336' : m.options.putCallRatio < 0.7 ? '#4CAF50' : '#FF9800'}}>
                            {m.options.putCallRatio}
                          </p>
                          <p style={{margin: '3px 0 0 0', fontSize: '10px', color: '#666'}}>Sentiment: {m.options.putCallRatio > 1 ? 'Bearish' : m.options.putCallRatio < 0.7 ? 'Bullish' : 'Neutral'}</p>
                        </div>
                      </>
                    )}
                    
                    {/* BACKTEST METRICS */}
                    {m.backtest && (
                      <>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #4CAF50'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>Strategy Return (since 2010)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#4CAF50'}}>+{m.backtest.finalReturn}%</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #2196F3'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>Buy & Hold Return</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#2196F3'}}>+{m.backtest.buyHold}%</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #FF6B6B'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>Max Drawdown</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#FF6B6B'}}>-{m.backtest.maxDD}%</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #1976D2'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>Sharpe Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#1976D2'}}>{m.backtest.sharpeRatio}</p>
                        </div>
                        <div style={{backgroundColor: '#e9ecef', padding: '10px', borderRadius: '4px', border: '2px solid #1976D2'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#495057', fontWeight: 'bold'}}>Sortino Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#1976D2'}}>{m.backtest.sortinoRatio}</p>
                        </div>
                        <div style={{backgroundColor: '#e8f5e9', padding: '10px', borderRadius: '4px', border: '2px solid #1976D2'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Calmar Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#1976D2'}}>{m.backtest.calmarRatio}</p>
                        </div>
                        <div style={{backgroundColor: '#f3e5f5', padding: '10px', borderRadius: '4px', border: '2px solid #7B1FA2'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Win Rate</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#7B1FA2'}}>{m.backtest.winRate}%</p>
                        </div>
                        <div style={{backgroundColor: '#f3e5f5', padding: '10px', borderRadius: '4px', border: '2px solid #7B1FA2'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Profit Factor</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#7B1FA2'}}>{m.backtest.profitFactor}</p>
                        </div>
                        <div style={{backgroundColor: '#e1f5fe', padding: '10px', borderRadius: '4px', border: '2px solid #0277BD'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Information Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#0277BD'}}>{m.backtest.informationRatio}</p>
                        </div>
                        <div style={{backgroundColor: '#e1f5fe', padding: '10px', borderRadius: '4px', border: '2px solid #0277BD'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>Omega Ratio</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#0277BD'}}>{m.backtest.omegaRatio}</p>
                        </div>
                        <div style={{backgroundColor: '#ffebee', padding: '10px', borderRadius: '4px', border: '2px solid #C62828'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>MAE (Avg)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#C62828'}}>{m.backtest.mae}%</p>
                        </div>
                        <div style={{backgroundColor: '#e8f5e9', padding: '10px', borderRadius: '4px', border: '2px solid #2E7D32'}}>
                          <p style={{margin: '0 0 5px 0', fontSize: '12px', color: '#666'}}>MFE (Avg)</p>
                          <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#2E7D32'}}>{m.backtest.mfe}%</p>
                        </div>
                        
                        {/* Backtest Comparison Summary */}
                        <div style={{
                          gridColumn: '1 / -1',
                          marginTop: '15px',
                          padding: '20px',
                          background: 'linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%)',
                          borderRadius: '12px',
                          border: '3px solid #4CAF50',
                          boxShadow: '0 4px 12px rgba(76,175,80,0.2)'
                        }}>
                          <h3 style={{margin: '0 0 15px 0', fontSize: '16px', fontWeight: 'bold', color: '#2E7D32', display: 'flex', alignItems: 'center', gap: '10px'}}>
                            <span>📊</span> Strategy vs Buy & Hold Validation
                          </h3>
                          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px'}}>
                            {(() => {
                              const strategyReturn = parseFloat(m.backtest.finalReturn)
                              const buyHoldReturn = parseFloat(m.backtest.buyHold)
                              const outperformance = strategyReturn - buyHoldReturn
                              const strategyCAGR = (Math.pow(1 + strategyReturn / 100, 1 / 15) - 1) * 100 // Approximate 15 years
                              const buyHoldCAGR = (Math.pow(1 + buyHoldReturn / 100, 1 / 15) - 1) * 100
                              const riskAdjustedReturn = parseFloat(m.backtest.sharpeRatio) > 0 ? strategyReturn / parseFloat(m.backtest.maxDD) : 0
                              
                              return (
                                <>
                                  <div style={{background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'}}>
                                    <p style={{margin: '0 0 8px 0', fontSize: '11px', color: '#666', fontWeight: 'bold', textTransform: 'uppercase'}}>Outperformance</p>
                                    <p style={{margin: 0, fontSize: '24px', fontWeight: 'bold', color: outperformance > 0 ? '#4CAF50' : '#F44336'}}>
                                      {outperformance > 0 ? '+' : ''}{outperformance.toFixed(1)}%
                                    </p>
                                    <p style={{margin: '5px 0 0 0', fontSize: '10px', color: '#666', fontStyle: 'italic'}}>
                                      Strategy vs Buy-Hold
                                    </p>
                                  </div>
                                  
                                  <div style={{background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'}}>
                                    <p style={{margin: '0 0 8px 0', fontSize: '11px', color: '#666', fontWeight: 'bold', textTransform: 'uppercase'}}>Strategy CAGR</p>
                                    <p style={{margin: 0, fontSize: '24px', fontWeight: 'bold', color: '#2196F3'}}>
                                      {strategyCAGR.toFixed(2)}%
                                    </p>
                                    <p style={{margin: '5px 0 0 0', fontSize: '10px', color: '#666', fontStyle: 'italic'}}>
                                      vs B&H: {buyHoldCAGR.toFixed(2)}%
                                    </p>
                                  </div>
                                  
                                  <div style={{background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'}}>
                                    <p style={{margin: '0 0 8px 0', fontSize: '11px', color: '#666', fontWeight: 'bold', textTransform: 'uppercase'}}>Risk-Adjusted</p>
                                    <p style={{margin: 0, fontSize: '24px', fontWeight: 'bold', color: '#FF9800'}}>
                                      {riskAdjustedReturn.toFixed(2)}x
                                    </p>
                                    <p style={{margin: '5px 0 0 0', fontSize: '10px', color: '#666', fontStyle: 'italic'}}>
                                      Return / Max DD ratio
                                    </p>
                                  </div>
                                  
                                  <div style={{background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'}}>
                                    <p style={{margin: '0 0 8px 0', fontSize: '11px', color: '#666', fontWeight: 'bold', textTransform: 'uppercase'}}>Win Rate</p>
                                    <p style={{margin: 0, fontSize: '24px', fontWeight: 'bold', color: '#9C27B0'}}>
                                      {m.backtest.winRate}%
                                    </p>
                                    <p style={{margin: '5px 0 0 0', fontSize: '10px', color: '#666', fontStyle: 'italic'}}>
                                      Profitable days
                                    </p>
                                  </div>
                                </>
                              )
                            })()}
                          </div>
                          <div style={{marginTop: '15px', padding: '12px', background: 'rgba(255,255,255,0.7)', borderRadius: '6px'}}>
                            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '15px'}}>
                              <p style={{margin: 0, fontSize: '12px', color: '#2E7D32', lineHeight: '1.6', flex: 1}}>
                                <strong>✅ Validation: </strong>
                                {(() => {
                                  const outperf = parseFloat(m.backtest.finalReturn) - parseFloat(m.backtest.buyHold)
                                  const sharpe = parseFloat(m.backtest.sharpeRatio)
                                  if (outperf > 50 && sharpe > 1.5) return 'STRONG EDGE - Strategy significantly outperforms with excellent risk-adjusted returns.'
                                  if (outperf > 20 && sharpe > 1.0) return 'MODERATE EDGE - Strategy adds value with acceptable risk profile.'
                                  if (outperf > 0) return 'MINOR EDGE - Strategy outperforms but consider risk metrics.'
                                  return 'NO EDGE - Buy & Hold performs better. Review strategy rules.'
                                })()}
                              </p>
                              {(() => {
                                const dataPoints = m.dataPoints
                                const strategyReturn = parseFloat(m.backtest.finalReturn)
                                const buyHoldReturn = parseFloat(m.backtest.buyHold)
                                const sharpeDiff = strategyReturn - buyHoldReturn
                                const years = dataPoints / 252
                                
                                let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM'
                                let color = '#FF9800'
                                let bgColor = '#FFF3E0'
                                
                                // High: >5 years data + Sharpe diff >1.0
                                if (years > 5 && sharpeDiff > 1.0) {
                                  confidence = 'HIGH'
                                  color = '#4CAF50'
                                  bgColor = '#E8F5E9'
                                // Medium: 3-5 years or Sharpe diff 0.5-1.0
                                } else if ((years >= 3 && years <= 5) || (sharpeDiff >= 0.5 && sharpeDiff <= 1.0)) {
                                  confidence = 'MEDIUM'
                                  color = '#FF9800'
                                  bgColor = '#FFF3E0'
                                // Low: <3 years or small edge
                                } else if (years < 3 || sharpeDiff < 0.5) {
                                  confidence = 'LOW'
                                  color = '#F44336'
                                  bgColor = '#FFEBEE'
                                }
                                
                                return (
                                  <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '8px 16px',
                                    background: bgColor,
                                    borderRadius: '20px',
                                    border: `2px solid ${color}`,
                                    whiteSpace: 'nowrap'
                                  }}>
                                    <span style={{fontSize: '16px'}}>
                                      {confidence === 'HIGH' ? '🟢' : confidence === 'MEDIUM' ? '🟡' : '🔴'}
                                    </span>
                                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                                      <span style={{fontSize: '10px', color: '#666', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px'}}>
                                        Confidence
                                      </span>
                                      <span style={{fontSize: '14px', fontWeight: 'bold', color: color}}>
                                        {confidence}
                                      </span>
                                    </div>
                                    <span style={{fontSize: '10px', color: '#666', marginLeft: '4px'}}>
                                      ({years.toFixed(1)}y)
                                    </span>
                                  </div>
                                )
                              })()}
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                    
                    {/* OPTIONS SELLING DASHBOARD - Only for SOXL */}
                    {symbol === 'SOXL' && (
                      <div style={{gridColumn: '1 / -1', marginTop: '20px', marginBottom: '20px'}}>
                        <div style={{
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          padding: '20px',
                          borderRadius: '12px',
                          marginBottom: '15px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}>
                          <div>
                            <h3 style={{margin: 0, color: 'white', fontSize: '20px', fontWeight: '700'}}>💼 Options Selling Dashboard</h3>
                            <p style={{margin: '5px 0 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.9)'}}>CSPs & Covered Calls Tracker</p>
                          </div>
                          <button 
                            onClick={exportToExcel}
                            style={{
                              padding: '10px 20px',
                              background: 'white',
                              color: '#667eea',
                              border: 'none',
                              borderRadius: '8px',
                              fontWeight: 'bold',
                              cursor: 'pointer',
                              fontSize: '14px',
                              boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
                            }}
                          >
                            📊 Export to Excel
                          </button>
                        </div>
                        
                        {/* LIVE OPTIONS CHAIN */}
                        <div style={{
                          background: 'white',
                          padding: '20px',
                          borderRadius: '12px',
                          marginBottom: '20px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                        }}>
                          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px'}}>
                            <h4 style={{margin: 0, color: '#333', fontSize: '18px', fontWeight: '700'}}>📈 Live Options Chain</h4>
                            
                            {/* CALLS/PUTS Toggle Buttons */}
                            <div style={{display: 'flex', gap: '10px'}}>
                              <button
                                onClick={() => setOptionTypeView('calls')}
                                style={{
                                  padding: '10px 24px',
                                  background: optionTypeView === 'calls' ? '#28a745' : '#e9ecef',
                                  color: optionTypeView === 'calls' ? 'white' : '#666',
                                  border: 'none',
                                  borderRadius: '8px',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  fontSize: '14px',
                                  transition: 'all 0.2s',
                                  boxShadow: optionTypeView === 'calls' ? '0 4px 8px rgba(40, 167, 69, 0.3)' : 'none'
                                }}
                              >
                                📞 CALLS (CC)
                              </button>
                              <button
                                onClick={() => setOptionTypeView('puts')}
                                style={{
                                  padding: '10px 24px',
                                  background: optionTypeView === 'puts' ? '#dc3545' : '#e9ecef',
                                  color: optionTypeView === 'puts' ? 'white' : '#666',
                                  border: 'none',
                                  borderRadius: '8px',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  fontSize: '14px',
                                  transition: 'all 0.2s',
                                  boxShadow: optionTypeView === 'puts' ? '0 4px 8px rgba(220, 53, 69, 0.3)' : 'none'
                                }}
                              >
                                📉 PUTS (CSP)
                              </button>
                            </div>
                          </div>
                          
                          {/* Suggest Best Strike Button */}
                          <div style={{marginBottom: '20px', textAlign: 'center'}}>
                            <button
                              onClick={() => {
                                const options = optionTypeView === 'calls' ? optionsChainData.calls : optionsChainData.puts
                                if (options.length === 0) return
                                
                                // Filter for options with ROI >= 8% and NOT in-the-money
                                const MIN_ROI = 8
                                let bestOption = null
                                let bestScore = 0
                                
                                options.forEach((opt: any) => {
                                  // Skip if in-the-money (ITM)
                                  if (opt.inTheMoney) return
                                  
                                  const premium = opt.lastPrice || ((opt.bid + opt.ask) / 2)
                                  const roi = (premium / opt.strike) * 100
                                  
                                  // Skip if ROI is below 8%
                                  if (roi < MIN_ROI) return
                                  
                                  // Calculate liquidity score (prioritize liquid options)
                                  const volume = opt.volume || 0
                                  const openInterest = opt.openInterest || 0
                                  const bidAskSpread = opt.bid > 0 ? ((opt.ask - opt.bid) / opt.bid) * 100 : 100
                                  
                                  // Liquidity score: prefer high volume, high OI, tight spread
                                  const volumeScore = Math.min(volume / 50, 1) // Max 50 volume
                                  const oiScore = Math.min(openInterest / 200, 1) // Max 200 OI
                                  const spreadScore = Math.max(0, 1 - (bidAskSpread / 20)) // Prefer tight spreads
                                  
                                  // Combined score: 50% liquidity, 50% ROI
                                  const liquidityScore = (volumeScore * 0.4 + oiScore * 0.4 + spreadScore * 0.2)
                                  const combinedScore = (roi / 50) * 0.5 + liquidityScore * 0.5 // ROI normalized to 50% max
                                  
                                  if (combinedScore > bestScore) {
                                    bestScore = combinedScore
                                    bestOption = opt
                                  }
                                })
                                
                                if (bestOption) {
                                  const optType = optionTypeView === 'calls' ? 'CC' : 'CSP'
                                  const premium = bestOption.lastPrice || ((bestOption.bid + bestOption.ask) / 2)
                                  const roi = (premium / bestOption.strike) * 100
                                  populatePositionFromChain('pos1', bestOption, optType)
                                  alert(`✅ Suggested ${optType} at $${bestOption.strike.toFixed(2)} with ${roi.toFixed(2)}% ROI!\n\nPremium: $${premium.toFixed(2)}\nVolume: ${bestOption.volume || 0}\nOI: ${bestOption.openInterest || 0}`)
                                } else {
                                  alert('⚠️ No options found with ROI >= 8% (OTM only). Try a different expiration date or adjust filters.')
                                }
                              }}
                              style={{
                                padding: '12px 24px',
                                fontSize: '14px',
                                fontWeight: 'bold',
                                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
                              onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                            >
                              🎯 Suggest Best {optionTypeView === 'calls' ? 'CC' : 'CSP'} Strike
                            </button>
                          </div>
                          
                          {/* Expiration Selector */}
                          <div style={{marginBottom: '20px'}}>
                            <label style={{display: 'block', marginBottom: '5px', fontSize: '12px', color: '#666', fontWeight: '600'}}>Expiration Date</label>
                            <select
                              value={selectedExpiration}
                              onChange={(e) => setSelectedExpiration(e.target.value)}
                              disabled={loadingOptions || optionsExpirations.length === 0}
                              style={{
                                width: '100%',
                                padding: '10px',
                                fontSize: '14px',
                                fontWeight: 'bold',
                                border: '2px solid #667eea',
                                borderRadius: '8px',
                                color: '#333',
                                background: loadingOptions ? '#f8f9fa' : 'white',
                                cursor: loadingOptions ? 'not-allowed' : 'pointer'
                              }}
                            >
                              {optionsExpirations.length === 0 ? (
                                <option>Loading expirations...</option>
                              ) : (
                                optionsExpirations.map(exp => {
                                  const daysToExp = Math.floor((new Date(exp).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                                  return (
                                    <option key={exp} value={exp}>
                                      {exp} ({daysToExp} DTE)
                                    </option>
                                  )
                                })
                              )}
                            </select>
                          </div>
                          
                          {/* Options Chain Table */}
                          {loadingOptions ? (
                            <div style={{padding: '40px', textAlign: 'center', color: '#666'}}>
                              <p>Loading options chain...</p>
                            </div>
                          ) : optionsChainData ? (
                            <div style={{overflowX: 'auto'}}>
                              {/* Single Options Chain View */}
                              <div style={{maxHeight: '500px', overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: '6px'}}>
                                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                                  <thead style={{position: 'sticky', top: 0, background: optionTypeView === 'calls' ? '#28a745' : '#dc3545', color: 'white', fontWeight: 'bold'}}>
                                    <tr>
                                      <th style={{padding: '12px 8px', textAlign: 'left'}}>Strike</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>Bid</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>Ask</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>Last</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>Volume</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>Open Int</th>
                                      <th style={{padding: '12px 8px', textAlign: 'right'}}>IV</th>
                                      <th style={{padding: '12px 8px', textAlign: 'center'}}>Add To Position</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(optionTypeView === 'calls' ? optionsChainData.calls : optionsChainData.puts)
                                      .filter((option: any) => !selectedStrike || option.strike === selectedStrike)
                                      .map((option: any, idx: number) => {
                                        const optType = optionTypeView === 'calls' ? 'CC' : 'CSP'
                                        const buttonColor = optionTypeView === 'calls' ? '#28a745' : '#dc3545'
                                        
                                        // Format values for display
                                        const lastPriceDisplay = option.lastPrice ? `$${option.lastPrice.toFixed(2)}` : ((option.bid + option.ask) / 2) > 0 ? `$${((option.bid + option.ask) / 2).toFixed(2)}` : '$0.00';
                                        const volumeDisplay = option.volume || 0;
                                        const openInterestDisplay = option.openInterest || 0;
                                        const ivDisplay = option.impliedVolatility ? `${(option.impliedVolatility * 100).toFixed(1)}%` : 'N/A';
                                        
                                        // Color-coding logic
                                        const iv = option.impliedVolatility ? option.impliedVolatility * 100 : 0
                                        const volume = option.volume || 0
                                        const bidAskSpread = option.bid > 0 ? ((option.ask - option.bid) / option.bid) * 100 : 0
                                        
                                        let rowBackground = 'white'
                                        let rowBorder = '1px solid #f0f0f0'
                                        
                                        if (iv > 100) {
                                          rowBackground = '#ffebee' // Light red - high IV = high premium opportunity
                                          rowBorder = '1px solid #ef5350'
                                        } else if (volume < 10) {
                                          rowBackground = '#f5f5f5' // Gray - low liquidity warning
                                          rowBorder = '1px solid #bdbdbd'
                                        } else if (bidAskSpread > 10) {
                                          rowBackground = '#fff3e0' // Light orange - wide spread
                                          rowBorder = '1px solid #ff9800'
                                        } else if (option.inTheMoney) {
                                          rowBackground = optionTypeView === 'calls' ? '#e8f5e9' : '#ffe0e0'
                                        }
                                        
                                        return (
                                          <tr key={idx} style={{
                                            borderBottom: rowBorder, 
                                            background: rowBackground,
                                            transition: 'background 0.2s'
                                          }}
                                          onMouseEnter={(e) => e.currentTarget.style.background = '#e3f2fd'}
                                          onMouseLeave={(e) => e.currentTarget.style.background = rowBackground}
                                          >
                                            <td style={{padding: '10px 8px', fontWeight: 'bold', fontSize: '14px', color: '#333'}}>${option.strike.toFixed(2)}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', color: '#28a745', fontWeight: '600'}}>${option.bid?.toFixed(2) || '0.00'}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', color: '#dc3545', fontWeight: '600'}}>${option.ask?.toFixed(2) || '0.00'}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', fontWeight: 'bold', fontSize: '14px', color: '#333'}}>{lastPriceDisplay}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', color: '#333'}}>{volumeDisplay.toLocaleString()}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', color: '#333'}}>{openInterestDisplay.toLocaleString()}</td>
                                            <td style={{padding: '10px 8px', textAlign: 'right', fontWeight: '600', color: '#333'}}>{ivDisplay}</td>
                                            <td style={{padding: '6px 8px', textAlign: 'center'}}>
                                              <div style={{display: 'flex', gap: '6px', justifyContent: 'center'}}>
                                                <button 
                                                  onClick={() => populatePositionFromChain('pos1', option, optType)} 
                                                  style={{
                                                    padding: '6px 12px', 
                                                    fontSize: '12px', 
                                                    background: buttonColor, 
                                                    color: 'white', 
                                                    border: 'none', 
                                                    borderRadius: '6px', 
                                                    cursor: 'pointer', 
                                                    fontWeight: 'bold',
                                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                                    transition: 'all 0.2s'
                                                  }}
                                                  onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
                                                  onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                                                >
                                                  Pos #1
                                                </button>
                                                <button 
                                                  onClick={() => populatePositionFromChain('pos2', option, optType)} 
                                                  style={{
                                                    padding: '6px 12px', 
                                                    fontSize: '12px', 
                                                    background: buttonColor, 
                                                    color: 'white', 
                                                    border: 'none', 
                                                    borderRadius: '6px', 
                                                    cursor: 'pointer', 
                                                    fontWeight: 'bold',
                                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                                    transition: 'all 0.2s'
                                                  }}
                                                  onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
                                                  onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                                                >
                                                  Pos #2
                                                </button>
                                                <button 
                                                  onClick={() => populatePositionFromChain('pos3', option, optType)} 
                                                  style={{
                                                    padding: '6px 12px', 
                                                    fontSize: '12px', 
                                                    background: buttonColor, 
                                                    color: 'white', 
                                                    border: 'none', 
                                                    borderRadius: '6px', 
                                                    cursor: 'pointer', 
                                                    fontWeight: 'bold',
                                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                                    transition: 'all 0.2s'
                                                  }}
                                                  onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
                                                  onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
                                                >
                                                  Pos #3
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                        )
                                      })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ) : (
                            <div style={{padding: '40px', textAlign: 'center', color: '#999'}}>
                              <p>No options data available</p>
                            </div>
                          )}
                        </div>
                        
                        {/* Save/Load Buttons */}
                        <div style={{display: 'flex', gap: '10px', marginBottom: '15px', justifyContent: 'center'}}>
                          <button
                            onClick={() => {
                              const positionsData = JSON.stringify(optionsPositions, null, 2)
                              localStorage.setItem('soxl_options_positions', positionsData)
                              
                              // Also download as JSON file
                              const blob = new Blob([positionsData], { type: 'application/json' })
                              const url = URL.createObjectURL(blob)
                              const link = document.createElement('a')
                              link.href = url
                              link.download = `SOXL_Positions_${new Date().toISOString().split('T')[0]}.json`
                              document.body.appendChild(link)
                              link.click()
                              document.body.removeChild(link)
                              URL.revokeObjectURL(url)
                              
                              alert('✅ Positions saved to browser storage and downloaded!')
                            }}
                            style={{
                              padding: '10px 20px',
                              fontSize: '13px',
                              fontWeight: 'bold',
                              background: '#28a745',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                            }}
                          >
                            💾 Save Positions
                          </button>
                          
                          <button
                            onClick={() => {
                              const saved = localStorage.getItem('soxl_options_positions')
                              if (saved) {
                                setOptionsPositions(JSON.parse(saved))
                                alert('✅ Positions loaded from browser storage!')
                              } else {
                                alert('⚠️ No saved positions found. Use "Save Positions" first.')
                              }
                            }}
                            style={{
                              padding: '10px 20px',
                              fontSize: '13px',
                              fontWeight: 'bold',
                              background: '#007bff',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                            }}
                          >
                            📂 Load Positions
                          </button>
                          
                          <label style={{
                            padding: '10px 20px',
                            fontSize: '13px',
                            fontWeight: 'bold',
                            background: '#6c757d',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                            display: 'inline-block'
                          }}>
                            📥 Import JSON
                            <input
                              type="file"
                              accept=".json"
                              style={{display: 'none'}}
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                if (file) {
                                  const reader = new FileReader()
                                  reader.onload = (event) => {
                                    try {
                                      const data = JSON.parse(event.target?.result as string)
                                      setOptionsPositions(data)
                                      alert('✅ Positions imported from JSON file!')
                                    } catch (err) {
                                      alert('❌ Invalid JSON file')
                                    }
                                  }
                                  reader.readAsText(file)
                                }
                              }}
                            />
                          </label>
                        </div>
                        
                        {/* Position 1 */}
                        <div style={{
                          background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
                          padding: '15px',
                          borderRadius: '10px',
                          marginBottom: '15px',
                          border: '2px solid #6c757d'
                        }}>
                          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                            <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#495057'}}>Position #1</p>
                            <div style={{display: 'flex', gap: '20px', fontSize: '12px'}}>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>SOXL Price</p>
                                <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#007bff'}}>${metrics?.SOXL?.currentPrice || 'N/A'}</p>
                              </div>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>Last Updated</p>
                                <p style={{margin: 0, fontSize: '11px', color: '#666'}}>{lastUpdated.split(',')[1] || 'Loading...'}</p>
                              </div>
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '10px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Type</p>
                              <select
                                value={optionsPositions.pos1.type}
                                onChange={(e) => updatePosition('pos1', 'type', e.target.value as any)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                <option value="CSP">CSP</option>
                                <option value="CC">CC</option>
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Strike Price</p>
                              <input 
                                type="number" 
                                value={optionsPositions.pos1.strike}
                                onChange={(e) => updatePosition('pos1', 'strike', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>DTE</p>
                              <select 
                                value={optionsPositions.pos1.dte}
                                onChange={(e) => updatePosition('pos1', 'dte', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                {optionsExpirations.map(exp => {
                                  const dte = Math.floor((new Date(exp).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                                  return <option key={exp} value={dte}>{dte} days</option>
                                })}
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}># of Shares</p>
                              <input 
                                type="number" 
                                step="100"
                                value={optionsPositions.pos1.shares}
                                onChange={(e) => updatePosition('pos1', 'shares', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Price/Contract</p>
                              <input 
                                type="number" 
                                step="0.01"
                                value={optionsPositions.pos1.pricePerContract}
                                onChange={(e) => updatePosition('pos1', 'pricePerContract', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginLeft: '90px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Premium</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#28a745'}}>${(optionsPositions.pos1.pricePerContract * optionsPositions.pos1.shares).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ACB</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#17a2b8'}}>${(optionsPositions.pos1.strike - ((optionsPositions.pos1.pricePerContract * optionsPositions.pos1.shares) / optionsPositions.pos1.shares)).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ROI</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#dc3545'}}>{(((optionsPositions.pos1.pricePerContract * optionsPositions.pos1.shares) / (optionsPositions.pos1.strike * optionsPositions.pos1.shares)) * 100).toFixed(2)}%</p>
                            </div>
                          </div>
                          {/* Greeks Display */}
                          {renderGreeksDisplay(optionsPositions.pos1, 'pos1')}
                        </div>
                        
                        {/* Position 2 */}
                        <div style={{
                          background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
                          padding: '15px',
                          borderRadius: '10px',
                          marginBottom: '15px',
                          border: '2px solid #6c757d'
                        }}>
                          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                            <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#495057'}}>Position #2</p>
                            <div style={{display: 'flex', gap: '20px', fontSize: '12px'}}>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>SOXL Price</p>
                                <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#007bff'}}>${metrics?.SOXL?.currentPrice || 'N/A'}</p>
                              </div>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>Last Updated</p>
                                <p style={{margin: 0, fontSize: '11px', color: '#666'}}>{lastUpdated.split(',')[1] || 'Loading...'}</p>
                              </div>
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '10px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Type</p>
                              <select
                                value={optionsPositions.pos2.type}
                                onChange={(e) => updatePosition('pos2', 'type', e.target.value as any)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                <option value="CSP">CSP</option>
                                <option value="CC">CC</option>
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Strike Price</p>
                              <input 
                                type="number" 
                                value={optionsPositions.pos2.strike}
                                onChange={(e) => updatePosition('pos2', 'strike', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>DTE</p>
                              <select 
                                value={optionsPositions.pos2.dte}
                                onChange={(e) => updatePosition('pos2', 'dte', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                {optionsExpirations.map(exp => {
                                  const dte = Math.floor((new Date(exp).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                                  return <option key={exp} value={dte}>{dte} days</option>
                                })}
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}># of Shares</p>
                              <input 
                                type="number" 
                                step="100"
                                value={optionsPositions.pos2.shares}
                                onChange={(e) => updatePosition('pos2', 'shares', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Price/Contract</p>
                              <input 
                                type="number" 
                                step="0.01"
                                value={optionsPositions.pos2.pricePerContract}
                                onChange={(e) => updatePosition('pos2', 'pricePerContract', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginLeft: '90px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Premium</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#28a745'}}>${(optionsPositions.pos2.pricePerContract * optionsPositions.pos2.shares).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ACB</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#17a2b8'}}>${(optionsPositions.pos2.strike - ((optionsPositions.pos2.pricePerContract * optionsPositions.pos2.shares) / optionsPositions.pos2.shares)).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ROI</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#dc3545'}}>{(((optionsPositions.pos2.pricePerContract * optionsPositions.pos2.shares) / (optionsPositions.pos2.strike * optionsPositions.pos2.shares)) * 100).toFixed(2)}%</p>
                            </div>
                          </div>
                          {/* Greeks Display */}
                          {renderGreeksDisplay(optionsPositions.pos2, 'pos2')}
                        </div>
                        
                        {/* Position 3 */}
                        <div style={{
                          background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
                          padding: '15px',
                          borderRadius: '10px',
                          marginBottom: '15px',
                          border: '2px solid #6c757d'
                        }}>
                          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                            <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#495057'}}>Position #3</p>
                            <div style={{display: 'flex', gap: '20px', fontSize: '12px'}}>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>SOXL Price</p>
                                <p style={{margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#007bff'}}>${metrics?.SOXL?.currentPrice || 'N/A'}</p>
                              </div>
                              <div>
                                <p style={{margin: '0 0 3px 0', color: '#6c757d'}}>Last Updated</p>
                                <p style={{margin: 0, fontSize: '11px', color: '#666'}}>{lastUpdated.split(',')[1] || 'Loading...'}</p>
                              </div>
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '10px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Type</p>
                              <select
                                value={optionsPositions.pos3.type}
                                onChange={(e) => updatePosition('pos3', 'type', e.target.value as any)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                <option value="CSP">CSP</option>
                                <option value="CC">CC</option>
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Strike Price</p>
                              <input 
                                type="number" 
                                value={optionsPositions.pos3.strike}
                                onChange={(e) => updatePosition('pos3', 'strike', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>DTE</p>
                              <select 
                                value={optionsPositions.pos3.dte}
                                onChange={(e) => updatePosition('pos3', 'dte', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              >
                                {optionsExpirations.map(exp => {
                                  const dte = Math.floor((new Date(exp).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                                  return <option key={exp} value={dte}>{dte} days</option>
                                })}
                              </select>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}># of Shares</p>
                              <input 
                                type="number" 
                                step="100"
                                value={optionsPositions.pos3.shares}
                                onChange={(e) => updatePosition('pos3', 'shares', parseInt(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Price/Contract</p>
                              <input 
                                type="number" 
                                step="0.01"
                                value={optionsPositions.pos3.pricePerContract}
                                onChange={(e) => updatePosition('pos3', 'pricePerContract', parseFloat(e.target.value) || 0)}
                                style={{width: '100%', padding: '6px', fontSize: '14px', fontWeight: 'bold', border: '1px solid #007bff', borderRadius: '4px', color: '#212529'}}
                              />
                            </div>
                          </div>
                          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginLeft: '90px'}}>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>Premium</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#28a745'}}>${(optionsPositions.pos3.pricePerContract * optionsPositions.pos3.shares).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ACB</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#17a2b8'}}>${(optionsPositions.pos3.strike - ((optionsPositions.pos3.pricePerContract * optionsPositions.pos3.shares) / optionsPositions.pos3.shares)).toFixed(2)}</p>
                            </div>
                            <div>
                              <p style={{margin: '0 0 3px 0', fontSize: '11px', color: '#6c757d'}}>ROI</p>
                              <p style={{margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#dc3545'}}>{(((optionsPositions.pos3.pricePerContract * optionsPositions.pos3.shares) / (optionsPositions.pos3.strike * optionsPositions.pos3.shares)) * 100).toFixed(2)}%</p>
                            </div>
                          </div>
                          {/* Greeks Display */}
                          {renderGreeksDisplay(optionsPositions.pos3, 'pos3')}
                        </div>
                        
                        {/* Totals Summary */}
                        <div style={{
                          background: 'linear-gradient(135deg, #28a745 0%, #20c997 100%)',
                          padding: '15px',
                          borderRadius: '10px',
                          marginTop: '15px',
                          border: '3px solid #155724',
                          color: 'white'
                        }}>
                          <p style={{margin: '0 0 10px 0', fontSize: '16px', fontWeight: 'bold', textAlign: 'center'}}>📊 Trades</p>
                          
                          {(() => {
                            const positions = [optionsPositions.pos1, optionsPositions.pos2, optionsPositions.pos3]
                            const totalPremium = positions.reduce((sum, pos) => sum + (pos.pricePerContract * pos.shares), 0)
                            
                            // Group by type (CSP vs CC)
                            const cspPositions = positions.filter(pos => pos.type === 'CSP' && pos.shares > 0)
                            const ccPositions = positions.filter(pos => pos.type === 'CC' && pos.shares > 0)
                            
                            // Calculate weighted average ACB for CSPs
                            let cspACB = 0
                            let cspTotalShares = 0
                            if (cspPositions.length > 0) {
                              cspPositions.forEach(pos => {
                                const posACB = pos.strike - (pos.pricePerContract * pos.shares) / pos.shares
                                cspACB += posACB * pos.shares
                                cspTotalShares += pos.shares
                              })
                              cspACB = cspACB / cspTotalShares
                            }
                            
                            // Calculate weighted average ACB for CCs
                            let ccACB = 0
                            let ccTotalShares = 0
                            if (ccPositions.length > 0) {
                              ccPositions.forEach(pos => {
                                const posACB = pos.strike - (pos.pricePerContract * pos.shares) / pos.shares
                                ccACB += posACB * pos.shares
                                ccTotalShares += pos.shares
                              })
                              ccACB = ccACB / ccTotalShares
                            }
                            
                            return (
                              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px'}}>
                                <div style={{textAlign: 'center'}}>
                                  <p style={{margin: '0 0 5px 0', fontSize: '11px', opacity: 0.9}}>Total Premium</p>
                                  <p style={{margin: 0, fontSize: '18px', fontWeight: 'bold'}}>${totalPremium.toFixed(2)}</p>
                                </div>
                                {cspPositions.length > 0 && (
                                  <div style={{textAlign: 'center'}}>
                                    <p style={{margin: '0 0 5px 0', fontSize: '11px', opacity: 0.9}}>CSP ACB ({cspTotalShares} shares)</p>
                                    <p style={{margin: 0, fontSize: '18px', fontWeight: 'bold'}}>${cspACB.toFixed(2)}</p>
                                  </div>
                                )}
                                {ccPositions.length > 0 && (
                                  <div style={{textAlign: 'center'}}>
                                    <p style={{margin: '0 0 5px 0', fontSize: '11px', opacity: 0.9}}>CC ACB ({ccTotalShares} shares)</p>
                                    <p style={{margin: 0, fontSize: '18px', fontWeight: 'bold'}}>${ccACB.toFixed(2)}</p>
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {m.backtest?.chartData && (
                    <div style={{marginTop: '20px'}}>
                      <h3 style={{margin: '0 0 10px 0', fontSize: '14px'}}>Strategy Performance</h3>
                      <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={m.backtest.chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis />
                          <Tooltip />
                          <Legend />
                          <Line type="monotone" dataKey="strategy" stroke="#4CAF50" name="Strategy" />
                          <Line type="monotone" dataKey="buyHold" stroke="#2196F3" name="Buy & Hold" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  
                  {m.volChart && (
                    <div style={{marginTop: '20px'}}>
                      <h3 style={{margin: '0 0 10px 0', fontSize: '14px'}}>Rolling Volatility (30-day)</h3>
                      <ResponsiveContainer width="100%" height={250}>
                        <BarChart data={m.volChart}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis />
                          <Tooltip />
                          <Bar dataKey="volatility" fill="#FF9800" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  
                  {m.beta?.rollingBetaChart && m.beta.rollingBetaChart.length > 0 && (
                    <div style={{marginTop: '20px', padding: '15px', background: m.beta.decayWarning ? '#ffebee' : '#f9f9f9', borderRadius: '8px', border: `2px solid ${m.beta.decayWarning ? '#F44336' : '#2196F3'}`}}>
                      <h3 style={{margin: '0 0 10px 0', fontSize: '14px', fontWeight: 'bold', color: m.beta.decayWarning ? '#C62828' : '#333'}}>
                        📊 Rolling Beta (60-day) {m.beta.decayWarning && ' - ⚠️ DECAY DETECTED'}
                      </h3>
                      <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={m.beta.rollingBetaChart}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis domain={[0, 'auto']} />
                          <Tooltip />
                          <Legend />
                          <Line type="monotone" dataKey="beta" stroke={m.beta.decayWarning ? '#F44336' : '#2196F3'} strokeWidth={2} name="Beta" />
                          <Line type="monotone" dataKey="threshold" stroke="#FF9800" strokeDasharray="5 5" strokeWidth={2} name="2.8 Threshold" />
                        </LineChart>
                      </ResponsiveContainer>
                      <p style={{margin: '10px 0 0 0', fontSize: '11px', color: '#666', fontStyle: 'italic'}}>
                        Beta below 2.8-2.9 consistently indicates leverage decay. Current: {m.beta.current} | Avg: {m.beta.beta}
                      </p>
                    </div>
                  )}
                  
                  {m.vixCorrelation?.rollingCorrelations && m.vixCorrelation.rollingCorrelations.length > 0 && (
                    <div style={{marginTop: '20px', padding: '15px', background: m.vixCorrelation.decouplingWarning ? '#ffebee' : '#f9f9f9', borderRadius: '8px', border: `2px solid ${m.vixCorrelation.decouplingWarning ? '#D32F2F' : '#F44336'}`}}>
                      <h3 style={{margin: '0 0 10px 0', fontSize: '14px', fontWeight: 'bold', color: m.vixCorrelation.decouplingWarning ? '#C62828' : '#333'}}>
                        ⚠️ Rolling VIX Correlation (60-day) {m.vixCorrelation.decouplingWarning && ' - 🚨 DECOUPLING WARNING'}
                      </h3>
                      <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={m.vixCorrelation.rollingCorrelations}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="day" />
                          <YAxis domain={[-1, 1]} />
                          <Tooltip />
                          <Legend />
                          <Line type="monotone" dataKey="correlation" stroke={m.vixCorrelation.decouplingWarning ? '#D32F2F' : '#F44336'} strokeWidth={2} name="Correlation" />
                          <ReferenceLine y={-0.4} stroke="#FF9800" strokeDasharray="5 5" label="Decoupling Threshold" />
                          <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
                        </LineChart>
                      </ResponsiveContainer>
                      <p style={{margin: '10px 0 0 0', fontSize: '11px', color: '#666', fontStyle: 'italic'}}>
                        VIX {'>'}25 with correlation {'>'}-0.4 = Decoupling from fear. Current VIX: {m.vixCorrelation.currentVIX} | Correlation: {m.vixCorrelation.correlation}
                      </p>
                      {m.vixCorrelation.decouplingWarning && (
                        <div style={{marginTop: '10px', padding: '10px', background: '#ffcdd2', borderRadius: '4px'}}>
                          <p style={{margin: 0, fontSize: '12px', color: '#C62828', fontWeight: 'bold'}}>
                            🚨 Risk Alert: SOXL showing weak negative correlation with VIX despite elevated fear levels. This suggests potential decoupling from traditional risk-off behavior.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  </>
                )}
              </div>
            </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}

// Legacy implementation moved to `src/LegacyApp.tsx` (kept here as disabled for reference).
