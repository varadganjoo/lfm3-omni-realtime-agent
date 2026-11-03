"""Verify the configured LAN endpoint, using its CA without changing OS trust."""
import asyncio
import hashlib
import json
import ssl
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parents[1]


async def main():
    config = json.loads((ROOT / 'runtime' / 'lan.json').read_text())
    origin = f'https://{config["address"]}:8443'
    setup = f'http://{config["address"]}:8789'
    context = ssl.create_default_context(cafile=str(ROOT / 'runtime' / 'tls' / 'companion-ca.pem'))
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=context), cookie_jar=aiohttp.CookieJar(unsafe=True), timeout=aiohttp.ClientTimeout(total=15)) as client:
        try:
            async with client.ws_connect(origin.replace('https:', 'wss:') + '/api/live/media', origin=origin):
                raise AssertionError('Media accepted without an existing session')
        except aiohttp.WSServerHandshakeError as error:
            assert error.status == 403, error.status
        async with client.get(origin + '/api/state') as response:
            assert response.status == 200
            state = await response.json()
            assert state['ready'] and state['liveReady'], state
            assert response.cookies['session']['secure']
        async with client.get(origin + '/', headers={'Host': 'untrusted.example'}) as response:
            assert response.status == 403
        async with client.post(origin + '/api/reset', json={}, headers={'Origin': 'https://example.com'}) as response:
            assert response.status == 403
        async with client.post(origin + '/api/reset', json={}, headers={'Origin': origin}) as response:
            assert response.status == 200
        async with client.ws_connect(origin.replace('https:', 'wss:') + '/api/live/media', origin=origin) as socket:
            for _ in range(20):
                message = await socket.receive_json(timeout=10)
                if message.get('type') == 'state' and message.get('state') == 'ready':
                    break
            else:
                raise AssertionError('Encrypted live media did not become ready')
        async with client.get(setup + '/') as response:
            assert response.status == 200
            page = await response.text()
            assert origin in page and 'No access code' in page
        async with client.get(setup + '/companion-ca.cer') as response:
            assert response.status == 200
            assert hashlib.sha256(await response.read()).hexdigest().upper() == config['certificateSha256']
        for path in ['/api/state', '/api/turn', '/server-key.pem', '/../../runtime/tls/server-key.pem']:
            async with client.get(setup + path) as response:
                assert response.status == 404, (path, response.status)
        async with client.get(setup + '/', headers={'Host': 'untrusted.example'}) as response:
            assert response.status == 403
    print('PASS: verified TLS chain/IP, Secure session cookie, host/origin rejection, encrypted live media, public-certificate fingerprint, setup-page isolation; no access code')


if __name__ == '__main__':
    asyncio.run(main())
