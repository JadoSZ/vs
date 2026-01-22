import requests

BASE = 'http://127.0.0.1:5000'

def test_logs_list():
    r = requests.get(f'{BASE}/api/logs', timeout=5)
    assert r.status_code == 200
    j = r.json()
    assert 'logs' in j

def test_log_content():
    r = requests.get(f'{BASE}/api/logs', timeout=5)
    files = r.json().get('logs', [])
    if not files:
        # if no logs yet, create one by requesting health
        requests.get(f'{BASE}/health')
        r = requests.get(f'{BASE}/api/logs', timeout=5)
        files = r.json().get('logs', [])
    assert len(files) > 0
    fname = files[0]
    r2 = requests.get(f'{BASE}/api/logs/{fname}', timeout=5)
    assert r2.status_code == 200
    assert len(r2.text) > 0
