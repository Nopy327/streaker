"""Configuration only. Change appearance in config.json to redesign the card."""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent


def load_config():
    load_dotenv(ROOT / '.env')
    raw = os.getenv('CONFIG_JSON')
    config = json.loads(raw) if raw else json.loads((ROOT / 'config.json').read_text())
    for key in ('bf', 'sbf'):
        game = config['games'][key]
        if not isinstance(game['place_id'], int) or game['place_id'] <= 0:
            raise ValueError(f'{key}: place_id must be a positive Roblox place ID.')
        if game['mode'] not in ('single_server', 'link', 'presence'):
            raise ValueError(f'{key}: mode must be single_server, link, or presence.')
    config['aliases'] = {k.casefold(): str(v) for k, v in config['aliases'].items()}
    config['public_role_ids'] = [int(x) for x in config['public_role_ids']]
    for key in ('public_cooldown_seconds', 'private_cooldown_seconds'):
        if not isinstance(config[key], int) or config[key] < 0:
            raise ValueError(f'{key} must be a nonnegative integer.')
    if not 1 <= config['max_private_recipients'] <= 20:
        raise ValueError('max_private_recipients must be between 1 and 20.')
    appearance = config['appearance']
    color = int(appearance['color'].lstrip('#'), 16)
    if not 0 <= color <= 0xFFFFFF:
        raise ValueError('appearance.color must be a six-digit hex color.')
    for key in ('attendance_button', 'locked_button'):
        if not 1 <= len(appearance[key]) <= 80:
            raise ValueError(f'{key} must be between 1 and 80 characters.')
    # Validate placeholders before a command can send anything.
    appearance['title'].format(game='Become Fumo')
    return config


def credentials():
    token = os.getenv('DISCORD_TOKEN', '')
    if not token or token == 'put_your_bot_token_here':
        raise ValueError('Set DISCORD_TOKEN in .env or in your host variables.')
    try:
        guild = int(os.environ['DISCORD_GUILD_ID'])
        channel = int(os.environ['HOP_CHANNEL_ID'])
        if guild <= 0 or channel <= 0:
            raise ValueError
    except (KeyError, ValueError):
        raise ValueError('Set DISCORD_GUILD_ID and HOP_CHANNEL_ID to your Discord IDs.')
    return token, guild, channel
