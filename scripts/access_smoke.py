"""Negative access checks against the authorised, local prototype only."""
import asyncio
import aiohttp

ORIGIN = 'http://127.0.0.1:8787'


async def rejected(client, url, **kwargs):
    try:
        async with client.ws_connect(url, **kwargs):
            raise AssertionError('An unauthorized media connection was accepted')
    except aiohttp.WSServerHandshakeError as error:
        assert error.status == 403, error.status


async def main():
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
        await rejected(client, 'ws://127.0.0.1:8787/api/live/media', origin=ORIGIN)
        async with client.get(ORIGIN + '/api/state') as response:
            assert response.status == 200
        await rejected(client, 'ws://127.0.0.1:8787/api/live/media', origin='https://example.com')
        await rejected(client, 'ws://127.0.0.1:8788/media', origin=ORIGIN)
        for path in ['cancel', 'turn', 'forget', 'reset', 'native']:
            async with client.post(ORIGIN + '/api/' + path, json={}, headers={'Origin': 'https://example.com'}) as response:
                assert response.status == 403, (path, response.status)
        for action in ['open', 'tool', 'close']:
            async with client.post(ORIGIN + '/api/native', json={'action': action}, headers={'Origin': ORIGIN}) as response:
                assert response.status == 403, ('native', action, response.status)
        await rejected(client, 'ws://127.0.0.1:8787/api/live/media?mode=unknown', origin=ORIGIN)
        await rejected(client, 'ws://127.0.0.1:8787/api/live/media?mode=native', origin='https://example.com')
        async with client.post(ORIGIN + '/api/turn', json={'video': 'https://example.com/private'}, headers={'Origin': ORIGIN}) as response:
            assert response.status == 404
        async with client.get('http://127.0.0.1:8081/v1/models') as response:
            assert response.status == 401
    print('PASS: missing session, wrong origin, private media/native tool auth, cross-origin writes, remote media rejection, model auth')


if __name__ == '__main__':
    asyncio.run(main())
