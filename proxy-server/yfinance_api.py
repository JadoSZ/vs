"""
yfinance API Proxy Server
Provides unlimited live market data via Flask
Run: python yfinance_api.py
"""

from flask import Flask, jsonify, Response, request
from flask_cors import CORS
import yfinance as yf
from datetime import datetime, timedelta
import logging
import json
import numpy as np
import pandas as pd

app = Flask(__name__)
CORS(app)

# Logging: file + stdout with timestamps for easier diagnostics
import logging, traceback, sqlite3, os
from collections import deque
from logging.handlers import RotatingFileHandler

LOG_FILE = 'proxy.log'
DB_FILE = 'proxy_data.db'

# Console + rotating file handler
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s', handlers=[logging.StreamHandler()])
logger = logging.getLogger('yfinance_proxy')
rot_handler = RotatingFileHandler(LOG_FILE, maxBytes=1024*1024, backupCount=5)
rot_handler.setLevel(logging.INFO)
rot_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s: %(message)s'))
logger.addHandler(rot_handler)

# In-memory IV history store: maintains rolling samples of median IVs per symbol (populated from DB)
iv_history: dict = {}
IV_HISTORY_MAX = 200

# --- SQLite persistence for IV history ---
def init_db():
    created = False
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute('''CREATE TABLE IF NOT EXISTS iv_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        ts TEXT NOT NULL,
        iv REAL NOT NULL
    )''')
    conn.commit()
    conn.close()
    # load recent history into memory
    try:
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        cur.execute('SELECT symbol, iv FROM iv_history ORDER BY id DESC LIMIT ?',(IV_HISTORY_MAX*10,))
        rows = cur.fetchall()
        conn.close()
        # rows newest-first; aggregate per symbol in reverse to keep chronological order
        temp = {}
        for sym, iv in reversed(rows):
            temp.setdefault(sym, deque(maxlen=IV_HISTORY_MAX)).append(iv)
        for k,v in temp.items():
            iv_history[k] = v
        logger.info('Loaded IV history for symbols: %s', ','.join(iv_history.keys()) or 'none')
    except Exception as e:
        logger.exception('Failed to load IV history from DB: %s', e)

def persist_iv(symbol: str, iv_value: float):
    try:
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        cur.execute('INSERT INTO iv_history(symbol, ts, iv) VALUES (?, ?, ?)', (symbol.upper(), datetime.now().isoformat(), float(iv_value)))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.exception('Failed to persist IV to DB: %s', e)

# Initialize DB on startup
init_db()

# Ensure consistent CORS headers for all endpoints (helps when the dev server
# origin may be 'localhost' or '127.0.0.1')
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS'
    return response

# Suppress yfinance logging
logging.getLogger('yfinance').setLevel(logging.CRITICAL)

# Helper function to make data JSON-safe
def to_json_serializable(obj):
    """Convert numpy/pandas types to JSON-serializable Python types"""
    if isinstance(obj, dict):
        return {k: to_json_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [to_json_serializable(item) for item in obj]
    elif isinstance(obj, (np.floating, float)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return float(obj)
    elif isinstance(obj, (np.integer, int)):
        return int(obj)
    elif isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    elif isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    elif obj is None or isinstance(obj, str):
        return obj
    else:
        return str(obj)

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})

@app.route('/api/live/<symbol>')
def get_live_data(symbol):
    """
    Get live market data for a symbol
    Returns: 180 days of historical prices + latest price
    """
    try:
        print(f"📊 Fetching {symbol}...")
        
        # Get last 180 days of historical data
        end = datetime.now()
        start = end - timedelta(days=180)
        
        ticker = yf.Ticker(symbol)
        hist = ticker.history(start=start, end=end)
        
        if hist.empty:
            return jsonify({'error': f'No data found for {symbol}'}), 404
        
        # Convert closing prices to list
        prices = hist['Close'].dropna().tolist()
        dates = [str(d.date()) for d in hist.index]
        
        # Get latest values (historical last close)
        latest_close = float(hist['Close'].iloc[-1])
        latest_date = str(hist.index[-1].date())

        # Attempt to get realtime quote info from yfinance
        try:
            info = ticker.info or {}
        except Exception:
            info = {}

        # Prefer live prices when available (pre/post/regular)
        current_price = info.get('regularMarketPrice') if info.get('regularMarketPrice') is not None else None
        pre_price = info.get('preMarketPrice') if info.get('preMarketPrice') is not None else None
        post_price = info.get('postMarketPrice') if info.get('postMarketPrice') is not None else None
        market_time_ts = info.get('regularMarketTime') or info.get('preMarketTime') or info.get('postMarketTime')
        market_time = None
        if market_time_ts:
            try:
                market_time = datetime.fromtimestamp(int(market_time_ts)).isoformat()
            except Exception:
                market_time = None

        # Determine market state and best current price to display
        market_state = 'CLOSED'
        best_current = None
        if post_price is not None:
            market_state = 'POST'
            best_current = post_price
        elif pre_price is not None:
            market_state = 'PRE'
            best_current = pre_price
        elif current_price is not None:
            market_state = 'REGULAR'
            best_current = current_price
        else:
            # Fallback: use latest historical close
            market_state = 'CLOSED'
            best_current = latest_close

        print(f"✅ {symbol}: hist close {latest_close} | current {best_current} ({market_state}) | {len(prices)} days")
        
        return jsonify({
            'ticker': symbol,
            'prices': prices,
            'dates': dates,
            'lastAdjClose': latest_close,
            'lastDate': latest_date,
            'currentPrice': best_current,
            'marketState': market_state,
            'marketTime': market_time,
            'timestamp': datetime.now().isoformat(),
            'dataPoints': len(prices)
        })
    
    except Exception as e:
        print(f"❌ Error fetching {symbol}: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/live/batch/<symbols>')
def get_batch_data(symbols):
    """
    Get data for multiple symbols at once
    Example: /api/live/batch/SOXL,SOXX,SPY
    """
    try:
        symbol_list = symbols.split(',')
        results = {}
        
        for symbol in symbol_list:
            print(f"📊 Fetching {symbol.upper()}...")
            
            end = datetime.now()
            start = end - timedelta(days=180)
            
            try:
                ticker = yf.Ticker(symbol)
                hist = ticker.history(start=start, end=end)
                
                if not hist.empty:
                    prices = hist['Close'].dropna().tolist()
                    dates = [str(d.date()) for d in hist.index]

                    # Try to fetch live quote info
                    try:
                        info = ticker.info or {}
                    except Exception:
                        info = {}
                    current_price = info.get('regularMarketPrice') if info.get('regularMarketPrice') is not None else (info.get('preMarketPrice') if info.get('preMarketPrice') is not None else (info.get('postMarketPrice') if info.get('postMarketPrice') is not None else None))
                    market_state = None
                    if info.get('postMarketPrice') is not None:
                        market_state = 'POST'
                    elif info.get('preMarketPrice') is not None:
                        market_state = 'PRE'
                    elif info.get('regularMarketPrice') is not None:
                        market_state = 'REGULAR'
                    else:
                        market_state = 'CLOSED'

                    results[symbol.upper()] = {
                        'prices': prices,
                        'dates': dates,
                        'lastAdjClose': float(hist['Close'].iloc[-1]),
                        'lastDate': str(hist.index[-1].date()),
                        'currentPrice': current_price,
                        'marketState': market_state,
                        'dataPoints': len(prices)
                    }
                    print(f"✅ {symbol.upper()}: {results[symbol.upper()]['lastAdjClose']} | current {current_price} ({market_state})")
                else:
                    results[symbol.upper()] = {'error': 'No data'}
                    print(f"⚠️ {symbol.upper()}: No data")
            except Exception as e:
                results[symbol.upper()] = {'error': str(e)}
                print(f"❌ {symbol.upper()}: {str(e)}")
        
        return jsonify({
            'data': results,
            'timestamp': datetime.now().isoformat()
        })
    
    except Exception as e:
        print(f"❌ Batch error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/options/<symbol>')
def get_options_chain(symbol):
    """
    Get options chain data for a symbol
    Returns: Available expiration dates and options data
    """
    try:
        print(f"📊 Fetching options chain for {symbol}...")
        
        ticker = yf.Ticker(symbol)
        
        # Get available expiration dates
        expirations = ticker.options
        
        if not expirations or len(expirations) == 0:
            return jsonify({'error': f'No options data available for {symbol}'}), 404
        
        print(f"✅ {symbol}: Found {len(expirations)} expiration dates")
        
        return jsonify({
            'symbol': symbol,
            'expirations': list(expirations),
            'timestamp': datetime.now().isoformat()
        })
    
    except Exception as e:
        print(f"❌ Error fetching options for {symbol}: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/options/<symbol>/<expiration>')
def get_options_by_expiration(symbol, expiration):
    """
    Get options chain for a specific expiration date
    Example: /api/options/SOXL/2026-02-20
    Returns: Calls and Puts data with strike, bid, ask, volume, OI, IV, Greeks
    """
    try:
        print(f"📊 Fetching options chain for {symbol} expiring {expiration}...")
        
        ticker = yf.Ticker(symbol)
        opt = ticker.option_chain(expiration)
        
        # Convert DataFrame to list of dicts
        calls = opt.calls.to_dict('records') if not opt.calls.empty else []
        puts = opt.puts.to_dict('records') if not opt.puts.empty else []
        
        # Make data JSON-safe
        calls = to_json_serializable(calls)
        puts = to_json_serializable(puts)
        
        print(f"✅ {symbol} {expiration}: {len(calls)} calls, {len(puts)} puts")
        if calls:
            print(f"   Sample call keys: {list(calls[0].keys())}")
            print(f"   Sample call data: {calls[0]}")
        
        response_data = {
            'symbol': symbol,
            'expiration': expiration,
            'calls': calls,
            'puts': puts,
            'timestamp': datetime.now().isoformat()
        }
        
        # Use custom JSON response to ensure safe encoding
        return Response(
            json.dumps(to_json_serializable(response_data)),
            mimetype='application/json'
        )
    
    except Exception as e:
        print(f"❌ Error fetching options chain: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# --- Intraday / minute-level endpoint ---
@app.route('/api/intraday/<symbol>')
def get_intraday(symbol):
    """Return intraday price series (period=1d). Optional query param: interval (1m,2m,5m,15m,30m,60m)"""
    interval = (request.args.get('interval') or '1m')
    allowed = ['1m','2m','5m','15m','30m','60m']
    if interval not in allowed:
        interval = '1m'
    try:
        print(f"⏱️ Fetching intraday {symbol} interval={interval}...")
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period='1d', interval=interval)
        if hist.empty:
            return jsonify({'error': f'No intraday data for {symbol} with interval {interval}'}), 404
        times = [idx.isoformat() for idx in hist.index]
        prices = hist['Close'].fillna(method='ffill').tolist()
        return jsonify({
            'symbol': symbol,
            'times': times,
            'prices': prices,
            'interval': interval,
            'timestamp': datetime.now().isoformat()
        })
    except Exception as e:
        print(f"❌ Intraday error for {symbol}: {e}")
        return jsonify({'error': str(e)}), 500


# --- Options surface endpoint: aggregate multiple expirations ---
@app.route('/api/options/surface/<symbol>')
def get_options_surface(symbol):
    """Return IV surface for nearest N expirations (query param n=3)
    Response: { expirations: [ { expiration, strikes: [ {strike, callIV, putIV} ] } ] }
    """
    try:
        n = int(request.args.get('n') or 3)
        n = max(1, min(10, n))
        print(f"📈 Building IV surface for {symbol} (n={n})...")
        ticker = yf.Ticker(symbol)
        expirations_all = ticker.options
        if not expirations_all:
            print(f"⚠️ No expirations for {symbol}; returning empty surface")
            return jsonify({'symbol': symbol, 'surface': [], 'expirations': [], 'timestamp': datetime.now().isoformat()})
        expirations = expirations_all[:n]
        surface = []
        all_ivs = []
        for exp in expirations:
            try:
                opt = ticker.option_chain(exp)
                calls = to_json_serializable(opt.calls.to_dict('records')) if not opt.calls.empty else []
                puts = to_json_serializable(opt.puts.to_dict('records')) if not opt.puts.empty else []
                # build strike map
                strikes = {}
                for c in calls:
                    s = c.get('strike')
                    strikes.setdefault(s, {})['callIV'] = c.get('impliedVolatility', None)
                    strikes[s]['callLast'] = c.get('lastPrice', c.get('last', None))
                    if c.get('impliedVolatility') is not None:
                        try:
                            all_ivs.append(float(c.get('impliedVolatility')))
                        except Exception:
                            pass
                for p in puts:
                    s = p.get('strike')
                    strikes.setdefault(s, {})['putIV'] = p.get('impliedVolatility', None)
                    strikes[s]['putLast'] = p.get('lastPrice', p.get('last', None))
                    if p.get('impliedVolatility') is not None:
                        try:
                            all_ivs.append(float(p.get('impliedVolatility')))
                        except Exception:
                            pass
                strike_list = [{'strike': k, 'callIV': v.get('callIV'), 'putIV': v.get('putIV'), 'callLast': v.get('callLast'), 'putLast': v.get('putLast')} for k,v in strikes.items()]
                strike_list_sorted = sorted(strike_list, key=lambda x: x['strike'])
                surface.append({'expiration': exp, 'strikes': strike_list_sorted})
            except Exception as e:
                logger.exception(f"Error building surface for expiry {exp} for {symbol}: {e}")
        # Compute median IV and percentile relative to stored history
        median_iv = None
        iv_percentile = None
        try:
            if all_ivs:
                all_ivs_sorted = sorted([v for v in all_ivs if v is not None])
                if all_ivs_sorted:
                    median_iv = all_ivs_sorted[len(all_ivs_sorted)//2]
            # record to history
            if median_iv is not None:
                # persist to in-memory history and DB
                hist = iv_history.get(symbol.upper(), deque(maxlen=IV_HISTORY_MAX))
                hist.append(median_iv)
                iv_history[symbol.upper()] = hist
                persist_iv(symbol.upper(), median_iv)
                # compute percentile
                arr = sorted(list(hist))
                if arr:
                    rank = sum(1 for x in arr if x <= median_iv)
                    iv_percentile = int(round(rank / len(arr) * 100))
        except Exception as e:
            logger.exception('Error computing IV median/percentile: %s', e)

        response = {'symbol': symbol, 'surface': surface, 'timestamp': datetime.now().isoformat()}
        if median_iv is not None:
            response['medianIV'] = median_iv
        if iv_percentile is not None:
            response['ivPercentile'] = iv_percentile
        return jsonify(response)
        return jsonify({'symbol': symbol, 'surface': surface, 'timestamp': datetime.now().isoformat()})
    except Exception as e:
        print(f"❌ Options surface error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/iv/history/<symbol>')
def iv_history_endpoint(symbol):
    """Return recent IV history and simple stats for a symbol (reads from DB if available)"""
    try:
        sym = symbol.upper()
        # Try to read recent history from DB
        try:
            conn = sqlite3.connect(DB_FILE)
            cur = conn.cursor()
            cur.execute('SELECT iv, ts FROM iv_history WHERE symbol=? ORDER BY id DESC LIMIT ?', (sym, IV_HISTORY_MAX))
            rows = cur.fetchall()
            conn.close()
            rows = list(reversed(rows))
            hist = [r[0] for r in rows]
        except Exception:
            hist = list(iv_history.get(sym, []))
        if not hist:
            return jsonify({'symbol': symbol, 'history': [], 'count': 0, 'median': None, 'percentile': None, 'timestamp': datetime.now().isoformat()})
        arr = sorted(hist)
        median = arr[len(arr)//2]
        percentile = int(round(sum(1 for x in arr if x <= median) / len(arr) * 100))
        return jsonify({'symbol': symbol, 'history': hist, 'count': len(hist), 'median': median, 'percentile': percentile, 'timestamp': datetime.now().isoformat()})
    except Exception as e:
        logger.exception('iv_history error: %s', e)
        return jsonify({'error': str(e)}), 500

@app.route('/api/logs')
def list_logs():
    try:
        files = [f for f in os.listdir('.') if f.startswith('proxy.log') or f.endswith('.log')]
        return jsonify({'logs': files, 'timestamp': datetime.now().isoformat()})
    except Exception as e:
        logger.exception('list_logs error: %s', e)
        return jsonify({'error': str(e)}), 500

@app.route('/api/logs/<path:fname>')
def get_log(fname):
    # Prevent path traversal
    if '..' in fname or fname.startswith('/'):
        return jsonify({'error': 'Invalid filename'}), 400
    if not os.path.exists(fname):
        return jsonify({'error': 'Not found'}), 404
    try:
        return Response(open(fname, 'rb').read(), mimetype='text/plain')
    except Exception as e:
        logger.exception('get_log error: %s', e)
        return jsonify({'error': str(e)}), 500

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    print("\n" + "="*60)
    print("🚀 yfinance API Proxy Server")
    print("="*60)
    print("📍 Running on: http://127.0.0.1:5000")
    print("✅ Endpoints:")
    print("   - GET /health")
    print("   - GET /api/live/<SYMBOL>")
    print("   - GET /api/live/batch/<SYM1,SYM2,SYM3>")
    print("   - GET /api/options/<SYMBOL>")
    print("   - GET /api/options/<SYMBOL>/<EXPIRATION>")
    print("\n💡 Keep this running while using the dashboard")
    print("="*60 + "\n")
    
    app.run(host='127.0.0.1', port=5000, debug=False, use_reloader=False)
