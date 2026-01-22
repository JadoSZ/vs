# Quick Start Guide - yfinance Live Tracking

## Step 1: Install Python Dependencies (One Time)
```bash
pip install flask yfinance flask-cors
```

## Step 2: Start Python Proxy Server
In **Terminal 1**, run:
```bash
python proxy-server/yfinance_api.py
```

Wait for this message:
```
🚀 yfinance API Proxy Server
📍 Running on: http://127.0.0.1:5000
```

## Step 3: Start React Dashboard
In **Terminal 2**, run:
```bash
npm run dev
```

Dashboard opens at: `http://127.0.0.1:5173`

## ✅ Now You Have:
- ✅ **Unlimited live market data** (yfinance, no rate limits)
- ✅ **1-2 second refresh intervals** during market hours
- ✅ **180 days of historical data** for all calculations
- ✅ **All features working**: Greeks, Beta, VIX, Alerts, etc.

## 🔍 Monitor Console Output

**Python Terminal (Port 5000):**
```
📊 Fetching SOXL...
✅ SOXL: 45.32 (180 days)
```

**React Terminal (Port 5173):**
```
✅ SOXL: Successfully fetched 180 data points. Last close: $45.32 on 2026-01-19
```

## 📝 Data Refresh Behavior

- **2-second interval** = 1800 requests/hour = ✅ No limits
- **1-second interval** = 3600 requests/hour = ✅ Still OK
- **Intraday streaming** = Not supported (yfinance is daily data only)

For true tick-by-tick, you'd need a dedicated market data provider.

## ❌ If Something Breaks

**Python not found:**
```bash
python3 proxy-server/yfinance_api.py
```

**Port 5000 already in use:**
- Find what's using it and close it, OR
- Edit the last line of `yfinance_api.py` to use port 5001

**CORS errors in browser:**
Flask-CORS is pre-configured, but check browser console for details.

**yfinance taking too long:**
First fetch = 5-10 seconds (downloading data), subsequent = instant.

## 🚀 You're Ready for Live Trading

Keep both terminals running during your trading session. All data refreshes automatically every 2 seconds.
