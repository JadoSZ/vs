import React from 'react'
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts'

type Props = { sparkData: any[] }

export default function PortfolioSummary({ sparkData }: Props) {
  return (
    <div className="card grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      <div className="md:col-span-2">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Portfolio Summary</h3>
          <div className="text-sm text-gray-400">Overview</div>
        </div>
        <div className="mt-3 h-48 bg-gray-900 border border-gray-800 rounded p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <Line dataKey="y" stroke="#7c3aed" strokeWidth={2} dot={false} />
              <XAxis dataKey="x" hide />
              <YAxis hide />
              <Tooltip />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="space-y-3">
        <div className="bg-gray-900 border border-gray-800 p-3 rounded">
          <div className="text-sm text-gray-400">Total Value</div>
          <div className="text-2xl font-bold">$123,456</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-3 rounded">
          <div className="text-sm text-gray-400">30d Vol</div>
          <div className="text-2xl font-bold">17.2%</div>
        </div>
      </div>
    </div>
  )
}
