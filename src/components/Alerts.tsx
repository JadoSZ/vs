import React from 'react'

type Props = {
  expanded: boolean
  onToggle: () => void
  showAll: boolean
  onToggleShowAll: () => void
}

export default function Alerts({ expanded, onToggle, showAll, onToggleShowAll }: Props) {
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <h2 className="text-lg font-semibold">Active Alerts</h2>
        <button onClick={onToggle} className="text-sm text-gray-300 hover:text-white">{expanded ? 'Collapse' : 'Expand'}</button>
      </div>
      {expanded && (
        <div className="mt-3">
          <div className="space-y-2">
            {[1,2,3,4].map(i => (
              <div key={i} className="flex items-center justify-between bg-gray-800 border border-gray-800 rounded p-2 hover:bg-gray-800 transition-all">
                <div className="text-sm">⚠️ Alert #{i} — Example alert description</div>
                <div className="text-xs text-gray-400">AAPL • High IV</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button onClick={onToggleShowAll} className="text-sm text-purple-300 hover:text-white">{showAll ? 'Show Less' : 'Show All'}</button>
            <div className="text-xs text-gray-400">4 active</div>
          </div>
        </div>
      )}
    </div>
  )
}
