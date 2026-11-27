"""Resolve a server once when an invitation is created; never guess among servers."""
import asyncio
import re
import time
from urllib.parse import parse_qs, urlencode, urlparse

import aiohttp


class ServerUnavailable(ValueError):
    pass


def instance_target(link):
    """Only extract an exact instance; share/private links do not reveal one."""
    query = parse_qs(urlparse(link or '').query)
    place = query.get('placeId', [''])[0]
    instance = query.get('gameInstanceId', [''])[0]
    if place.isdigit() and instance:
        return int(place), instance
    return None


class PublicServerTracker:
    """One cached lookup per place, shared by all public and DM cards."""
    def __init__(self, http, interval=30):
        self.http = http
        self.interval = interval
        self.cache = {}
        self.lock = asyncio.Lock()

    async def servers(self, place):
        async with self.lock:
            cached = self.cache.get(place)
            if cached and time.monotonic() - cached[0] < self.interval:
                if isinstance(cached[1], ServerUnavailable):
                    raise cached[1]
                return cached[1]
            try:
                found, cursor = {}, None
                for _ in range(20):
                    params = {'limit': '100', 'sortOrder': 'Asc', 'excludeFullGames': 'false'}
                    if cursor:
                        params['cursor'] = cursor
                    data = await get_json(self.http,
                                          f'https://games.roblox.com/v1/games/{place}/servers/Public', params=params)
                    if not isinstance(data, dict) or not isinstance(data.get('data'), list):
                        raise ServerUnavailable('Roblox returned an incomplete server list.')
                    for server in data['data']:
                        if not isinstance(server.get('playing'), int) or server['playing'] < 0:
                            raise ServerUnavailable('Roblox did not return a valid player count.')
                        found[server['id']] = server
                    cursor = data.get('nextPageCursor')
                    if not cursor:
                        self.cache[place] = (time.monotonic(), found)
                        return found
                raise ServerUnavailable('The server list could not be fully checked.')
            except ServerUnavailable as exc:
                # Cache failures too, so many cards do not hammer a rate-limited API.
                self.cache[place] = (time.monotonic(), exc)
                raise

    async def population(self, link):
        target = instance_target(link)
        if not target:
            return {'status': 'unknown', 'players': None, 'capacity': None}
        place, instance = target
        servers = await self.servers(place)
        if instance not in servers:
            return {'status': 'offline', 'players': None, 'capacity': None}
        server = servers[instance]
        return {'status': 'live', 'players': server['playing'], 'capacity': server.get('maxPlayers')}


def instance_link(place_id, job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,100}', job_id):
        raise ServerUnavailable('Roblox returned an invalid server ID.')
    return 'https://www.roblox.com/games/start?' + urlencode({
        'placeId': place_id, 'gameInstanceId': job_id,
    })


def validate_link(value):
    parsed = urlparse(value)
    if (len(value) > 512 or parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.hostname not in ('roblox.com', 'www.roblox.com', 'ro.blox.com')
            or parsed.port not in (None, 443)):
        raise ServerUnavailable('Configure an HTTPS Roblox server/share link in join_url.')
    return value


async def get_json(http, url, method='GET', **kwargs):
    try:
        async with http.request(method, url, **kwargs) as response:
            if response.status != 200:
                raise ServerUnavailable(f'Roblox server lookup is unavailable (HTTP {response.status}).')
            return await response.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        if isinstance(exc, ServerUnavailable):
            raise
        raise ServerUnavailable('Roblox server lookup failed. Try again shortly.') from exc


async def resolve_server(game, http):
    mode = game['mode']
    place = int(game['place_id'])
    if mode == 'link':
        return validate_link(game['join_url']), 'Join the linked server.'
    if mode == 'presence':
        uid = game.get('fumocam_user_id')
        if not uid or not str(uid).isdigit():
            raise ServerUnavailable('Set fumocam_user_id to the Roblox account ID first.')
        data = await get_json(http, 'https://presence.roblox.com/v1/presence/users',
                              method='POST', json={'userIds': [int(uid)]})
        records = data.get('userPresences', [])
        presence = next((p for p in records if str(p.get('userId')) == str(uid)), None)
        if not presence or presence.get('userPresenceType') != 2:
            raise ServerUnavailable('Fumocam is not reported as playing right now.')
        if place not in (presence.get('placeId'), presence.get('rootPlaceId')):
            raise ServerUnavailable('Fumocam is not reported in the selected game, or its location is hidden.')
        if not presence.get('gameId'):
            raise ServerUnavailable('Roblox is hiding Fumocam\'s server. Use a server link or single_server mode.')
        return instance_link(presence.get('placeId') or place, presence['gameId']), 'Fumocam\'s server when this invitation was created.'
    if mode != 'single_server':
        raise ServerUnavailable('Unknown server selection mode.')
    cursor = None
    found = {}
    # Exhaust the list, or stop as soon as ambiguity is established.
    for _ in range(20):
        params = {'limit': '100', 'sortOrder': 'Asc', 'excludeFullGames': 'false'}
        if cursor:
            params['cursor'] = cursor
        data = await get_json(http, f'https://games.roblox.com/v1/games/{place}/servers/Public', params=params)
        for server in data.get('data', []):
            if server.get('playing', 0) > 0:
                found[server['id']] = server
        if len(found) > 1:
            raise ServerUnavailable('Several public servers have players. Configure a specific server link to choose one.')
        cursor = data.get('nextPageCursor')
        if not cursor:
            if not found:
                raise ServerUnavailable('No public server with players was found for this game.')
            server = next(iter(found.values()))
            return instance_link(place, server['id']), 'The only occupied public server when this invitation was created.'
    raise ServerUnavailable('The server list could not be fully checked. Configure a specific server link.')
