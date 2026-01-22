import React from 'react'

type Props = {
  watchlist: string[]
  watchData: Record<string, any>
  onOpenOptions: (sym: string) => void
}

export default function Watchlist({ watchlist, watchData, onOpenOptions }: Props) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Watchlist Monitor</h2>
        <div className="text-sm text-gray-400">Compact</div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm table-auto">
          <thead className="text-xs text-gray-400">
            <tr>
              <th className="text-left py-2">Ticker</th>
              <th className="text-right py-2">Price</th>
              <th className="text-right py-2">% Change</th>
              <th className="text-right py-2">RSI</th>
              <th className="text-right py-2">Regime</th>
              <th className="text-right py-2">IV%</th>
              <th className="text-right py-2">Score</th>
              <th className="text-center py-2">Alert</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {watchlist.map(t => {
              const d = watchData[t] || {}
              return (
                <tr key={t} className="hover:bg-gray-800 transition-all">
                  <td className="py-2">{t}</td>
                  <td className="py-2 text-right">{d.price != null ? d.price.toFixed(2) : '—'}</td>
                  <td className={`py-2 text-right ${d.change != null ? (d.change >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                    {d.change != null ? `${d.change}%` : '—'}
                  </td>
                  <td className="py-2 text-right">{d.rsi ?? '—'}</td>
                  <td className="py-2 text-right">{d.regime ?? '—'}</td>
                  <td className="py-2 text-right">{d.ivPercentile != null ? `${d.ivPercentile}%` : '—'}</td>
                  <td className="py-2 text-right">{d.score ?? '—'}</td>
                  <td className="py-2 text-center">
                    {d.nextExpiration ? <button onClick={() => onOpenOptions(t)} className="text-sm text-purple-300 hover:text-white">Options</button> : <span className="text-xs text-gray-500">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
