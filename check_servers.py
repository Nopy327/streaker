"""Read Roblox's server list without logging into Discord or sending invitations."""
import asyncio

import aiohttp

from roblox import PublicServerTracker, ServerUnavailable, resolve_server
from settings import load_config


async def main():
    config = load_config()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as http:
        tracker = PublicServerTracker(http)
        for key, game in config['games'].items():
            try:
                link, note = await resolve_server(game, http)
                print(f'{key}: {note}\n{link}')
                population = await tracker.population(link)
                print(f'Population: {population["status"]}, players={population["players"]}, capacity={population["capacity"]}')
            except ServerUnavailable as exc:
                print(f'{key}: {exc}')


if __name__ == '__main__':
    asyncio.run(main())
