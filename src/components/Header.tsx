import React from 'react'

type Props = {
  lastRefresh: string
  onRefresh: () => void
  onExport?: () => void
}

export default function Header({ lastRefresh, onRefresh, onExport }: Props) {
  return (
    <header className="flex items-center justify-between bg-purple-900 text-white rounded-lg shadow-md p-4 mb-6">
      <h1 className="text-3xl font-bold">Market Intelligence &amp; Risk Management</h1>
      <div className="flex items-center gap-4">
        <div className="text-sm opacity-90">Last refresh: <span className="font-mono">{lastRefresh}</span></div>
        <button onClick={onRefresh} className="btn-primary">Refresh</button>
        <button onClick={onExport} className="btn-primary ml-2">Export to Excel</button>
      </div>
    </header>
  )
}
