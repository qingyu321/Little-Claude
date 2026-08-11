import hashlib, json, ssl, urllib.request

c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); c.check_hostname = False; c.verify_mode = ssl.CERT_NONE

def get(url, head=False):
    req = urllib.request.Request(url, method='HEAD' if head else 'GET')
    with urllib.request.urlopen(req, context=c, timeout=60) as r:
        return r.status, dict(r.headers), r.read() if not head else b''

# 1. raw latest.json
st, h, body = get('https://raw.githubusercontent.com/qingyu321/Little-Claude/main/latest.json')
d = json.loads(body)
print('1. raw latest.json:', json.dumps(d, ensure_ascii=False))
assert d['version'] == '1.1.3', 'version mismatch'

# 2. download zip, compare sha256
st, h, body = get('https://github.com/qingyu321/Little-Claude/releases/download/v1.1.3/web-dist-v1.1.3.zip')
sha = hashlib.sha256(body).hexdigest()
print('2. web-dist zip  sha256:', sha, '| size:', len(body))
assert sha == 'b220f437a4ca6d91d23106daed4146eb7639d6be4c6366a42ddcef5d4d9d1914', 'zip sha mismatch'

# 3. exe HEAD -> Content-Length
st, h, body = get('https://github.com/qingyu321/Little-Claude/releases/download/v1.1.3/Little.Claude.v1.1.3.exe', head=True)
cl = h.get('Content-Length')
print('3. exe HEAD status:', st, '| Content-Length:', cl)
assert cl == '54025728', f'exe size mismatch: {cl}'
print('ALL VERIFIED OK')
