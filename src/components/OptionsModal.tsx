import React from 'react'

type Props = {
  open: boolean
  symbol: string | null
  loading: boolean
  data: any
  onClose: () => void
  onRetry: () => void
}

export default function OptionsModal({ open, symbol, loading, data, onClose, onRetry }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 w-11/12 max-w-2xl">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Options — {symbol}</h4>
          <div className="flex items-center gap-2">
            <button onClick={onRetry} className="bg-gray-800 px-3 py-1 rounded hover:bg-gray-800 text-sm">Retry</button>
            <button onClick={onClose} className="text-sm text-gray-400">Close</button>
          </div>
        </div>
        {loading ? (
          <div className="text-sm text-gray-400">Loading options...</div>
        ) : data ? (
          data.error ? (
            <div className="text-sm text-red-400">Error: {data.error}</div>
          ) : (
            <div className="text-sm text-gray-300">
              <div>Expirations: {(data.expirations || []).slice(0,5).join(', ') || '—'}</div>
              <div className="mt-2">Calls: {(data.calls || []).length || '—'} • Puts: {(data.puts || []).length || '—'}</div>
            </div>
          )
        ) : <div className="text-sm text-gray-400">No data</div>}
      </div>
    </div>
  )
}
