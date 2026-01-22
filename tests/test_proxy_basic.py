import requests
import time

BASE = 'http://127.0.0.1:5000'

def test_health():
    # Retry loop to allow server to start in CI/dev environment
    deadline = time.time() + 8
    last_exc = None
    while time.time() < deadline:
        try:
            r = requests.get(f'{BASE}/health', timeout=2)
            assert r.status_code == 200
            j = r.json()
            assert 'status' in j and j['status'] == 'ok'
            return
        except Exception as e:
            last_exc = e
            time.sleep(0.5)
    raise last_exc or AssertionError('health check failed')
