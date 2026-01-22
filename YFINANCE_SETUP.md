# yfinance Proxy Setup

## Prerequisites
Ensure you have Python 3.8+ installed. Check with:
```bash
python --version
```

## Installation

### Step 1: Install Dependencies
```bash
pip install flask yfinance flask-cors
```

If you have multiple Python versions, use:
```bash
pip3 install flask yfinance flask-cors
```

### Step 2: Verify Installation
```bash
pip list | findstr flask yfinance
```

Should show:
- Flask (version 2.x+)
- yfinance (version 0.2.x+)
- flask-cors (version 4.x+)

## Running the Servers

### Terminal 1: Start the Python Proxy
```bash
python proxy-server/yfinance_api.py
```

You should see:
```
============================================================
🚀 yfinance API Proxy Server
============================================================
📍 Running on: http://127.0.0.1:5000
✅ Endpoints:
   - GET /health
   - GET /api/live/<SYMBOL>
   - GET /api/live/batch/<SYM1,SYM2,SYM3>

💡 Keep this running while using the dashboard
============================================================
```

### Terminal 2: Start the React Dashboard
```bash
npm run dev
```

Dashboard runs on: `http://localhost:5173`

## Testing

Once both servers are running:

### Test 1: Proxy Health
```bash
curl http://127.0.0.1:5000/health
```

### Test 2: Single Symbol
```bash
curl http://127.0.0.1:5000/api/live/SOXL
```

### Test 3: Multiple Symbols
```bash
curl http://127.0.0.1:5000/api/live/batch/SOXL,SOXX,SPY,VIX
```

## Troubleshooting

### "ModuleNotFoundError: No module named 'flask'"
```bash
pip install --upgrade pip
pip install flask yfinance flask-cors
```

### Port 5000 Already in Use
The proxy server tried to start on port 5000 but it's busy. Edit `yfinance_api.py` (last line):
```python
app.run(port=5001, debug=False, use_reloader=False)  # Change 5000 to 5001
```

Then update App.tsx to use the new port:
```typescript
const response = await fetch(`http://127.0.0.1:5001/api/live/${symbol}`);
```

### yfinance Takes Too Long
First data fetch may take 5-10 seconds (downloading 180 days). Subsequent calls cache within the session.

### CORS Errors
Flask-CORS is configured in `yfinance_api.py`. If issues persist, check browser console for specific error messages.

## Data Refresh Intervals

The proxy fetches fresh data from Yahoo Finance on each request:
- **2-second refresh** = 1800 requests/hour = ✅ No rate limits (Yahoo allows this)
- **1-second refresh** = 3600 requests/hour = ✅ Still OK (generous limits)

You can safely refresh every 1-2 seconds during market hours (9:30 AM - 4:00 PM ET).

## What Changed in React App

The `fetchLiveData()` function in `App.tsx` now:
1. Calls `http://127.0.0.1:5000/api/live/<symbol>` instead of Tiingo
2. Expects the same data format: `{prices[], lastAdjClose, lastDate}`
3. Works identically with all calculations (MACD, RSI, Beta, etc.)

## Keeping Servers Running

While developing:
- Keep Terminal 1 (Python proxy) open
- Keep Terminal 2 (React dev server) open
- Both windows must stay running during your trading session

When done, press `Ctrl+C` in each terminal to stop.

## Production Notes

For production trading, see `SECURITY_GUIDE.md` for:
- Authentication
- Rate limiting
- Data validation
- Error handling
- Deployment options
