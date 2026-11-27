"""Run with python bot.py. No message-content intent, web server, or Roblox login."""
import argparse
import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Optional

import aiohttp
import discord
from discord import app_commands
from discord.ext import tasks

from recipients import resolve_recipients
from roblox import PublicServerTracker, ServerUnavailable, resolve_server
from settings import ROOT, credentials, load_config
from store import SessionError, Store
from ui import SessionView, safe_name

LOG = logging.getLogger('fumo')
NO_MENTIONS = discord.AllowedMentions.none()


class HopBot(discord.Client):
    def __init__(self, config, guild_id, channel_id, store):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.members = True
        super().__init__(intents=intents, allowed_mentions=NO_MENTIONS)
        self.config = config
        self.guild_id = guild_id
        self.channel_id = channel_id
        self.store = store
        self.tree = app_commands.CommandTree(self)
        self.http_session = None
        self.server_tracker = None
        self.last_population_check = 0
        self.refresh_lock = asyncio.Lock()
        self.register_commands()

    def register_commands(self):
        guild = discord.Object(id=self.guild_id)

        @self.tree.command(name='hop', description='Invite everyone to Become Fumo.', guild=guild)
        async def hop(interaction: discord.Interaction):
            await self.create_hop(interaction, 'bf', None)

        advanced = app_commands.Group(name='advanced', description='Choose a game and optional private invitees.')

        @advanced.command(name='hop', description='Invite everyone or selected people to BF or SBF.')
        @app_commands.describe(game='bf = Become Fumo; sbf = Scuffed Become Fumo',
                               private_users='Optional names, aliases or mentions: loogi ori')
        @app_commands.rename(private_users='private')
        @app_commands.choices(game=[app_commands.Choice(name='bf', value='bf'),
                                    app_commands.Choice(name='sbf', value='sbf')])
        async def advanced_hop(interaction: discord.Interaction, game: app_commands.Choice[str],
                               private_users: Optional[str] = None):
            await self.create_hop(interaction, game.value, private_users)

        self.tree.add_command(advanced, guild=guild)

        @self.tree.error
        async def command_error(interaction, error):
            LOG.error('Command error: %s', type(error).__name__)
            await self.private_error(interaction, 'The command failed. Check the bot configuration and try again.')

    async def setup_hook(self):
        self.http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12))
        self.server_tracker = PublicServerTracker(self.http_session)
        self.store.expire()
        for session in self.store.all():
            if not session['locked']:
                for copy in self.store.copies(session['id']):
                    self.add_view(SessionView(self, session), message_id=int(copy['message_id']))
        # Repaint saved cards using the latest layout after a code deployment.
        # Message edits carry no @everyone mention, so they do not re-ping.
        self.store.invalidate_copies()
        await self.tree.sync(guild=discord.Object(id=self.guild_id))
        self.maintenance.start()

    async def on_ready(self):
        LOG.info('Logged in as %s. /hop and /advanced hop are registered.', self.user)

    async def private_error(self, interaction, text):
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=True, allowed_mentions=NO_MENTIONS)
        else:
            await interaction.response.send_message(text, ephemeral=True, allowed_mentions=NO_MENTIONS)

    async def authorize_attendance(self, sid, user_id):
        session = self.store.get(sid)
        self.store.authorize(session, user_id)
        guild = self.get_guild(int(session['guild_id']))
        if guild is None:
            raise SessionError('The invitation server is unavailable.')
        member = guild.get_member(user_id)
        if member is None:
            try:
                member = await guild.fetch_member(user_id)
            except discord.NotFound as exc:
                raise SessionError('You must still be a member of the invitation server.') from exc
        if member.bot:
            raise SessionError('Bot accounts cannot join an attendance list.')
        return session

    async def target_channel(self, interaction):
        channel = self.get_channel(self.channel_id) or await self.fetch_channel(self.channel_id)
        if not isinstance(channel, discord.TextChannel) or channel.guild.id != self.guild_id:
            raise SessionError('HOP_CHANNEL_ID must be a text channel in the configured Discord server.')
        me = channel.guild.me
        permissions = channel.permissions_for(me)
        needed = ('view_channel', 'send_messages', 'embed_links', 'attach_files', 'read_message_history', 'mention_everyone')
        missing = [name for name in needed if not getattr(permissions, name)]
        if missing:
            raise SessionError('The bot needs these channel permissions: ' + ', '.join(missing))
        caller = channel.permissions_for(interaction.user)
        allowed_roles = set(self.config['public_role_ids'])
        if not (caller.mention_everyone or caller.manage_guild or
                any(role.id in allowed_roles for role in interaction.user.roles)):
            raise SessionError('Public hops need Mention @everyone permission or a role listed in public_role_ids.')
        return channel

    async def create_hop(self, interaction, game_key, private_text):
        await interaction.response.defer(ephemeral=True, thinking=True)
        cooldown_key = None
        session = None
        delivered = 0
        try:
            if interaction.guild_id != self.guild_id or not isinstance(interaction.user, discord.Member):
                raise SessionError('Run this command in the configured Discord server.')
            is_private = private_text is not None
            if is_private:
                guild = interaction.guild
                if not guild.chunked:
                    await guild.chunk(cache=True)
                recipients = resolve_recipients(private_text, guild.members, self.config['aliases'],
                                                 interaction.user, self.config['max_private_recipients'])
                cooldown_key = f'private:{self.guild_id}:{interaction.user.id}'
                cooldown_seconds = self.config['private_cooldown_seconds']
                channel = None
            else:
                recipients = None
                channel = await self.target_channel(interaction)
                cooldown_key = f'public:{self.guild_id}'
                cooldown_seconds = self.config['public_cooldown_seconds']
            # Reserve before any network await to prevent simultaneous commands bypassing cooldown.
            key = cooldown_key
            cooldown_key = None
            self.store.reserve_cooldown(key, cooldown_seconds)
            cooldown_key = key
            game = self.config['games'][game_key]
            try:
                url, note = await resolve_server(game, self.http_session)
            except ServerUnavailable as exc:
                url, note = None, 'Roblox server lookup unavailable: ' + str(exc)
            session = self.store.create(
                self.guild_id, game_key, game['name'], interaction.user.id, interaction.user.display_name,
                [str(member.id) for member in recipients] if is_private else None, url, note,
            )
            await self.update_population(session)
            session = self.store.get(session['id'])
            failed = []
            if is_private:
                # Sequential delivery makes each receipt durable before attempting the next DM.
                for member in recipients:
                    try:
                        message = await member.send(view=SessionView(self, session), allowed_mentions=NO_MENTIONS)
                        delivered += 1
                        self.store.add_copy(session['id'], message.channel.id, message.id, session['revision'])
                    except discord.HTTPException:
                        failed.append(safe_name(member.display_name))
                result = f'Private invitation delivered to {delivered} of {len(recipients)} people, including you.'
                if failed:
                    result += '\nCould not DM: ' + ', '.join(failed) + '. They may have DMs disabled.'
            else:
                message = await channel.send(
                    view=SessionView(self, session),
                    allowed_mentions=discord.AllowedMentions(everyone=True, users=False, roles=False, replied_user=False),
                )
                delivered += 1
                self.store.add_copy(session['id'], message.channel.id, message.id, session['revision'])
                result = f'Invitation posted in {channel.mention}: {message.jump_url}'
            if not url:
                result += '\n' + note
            if not delivered:
                self.store.delete(session['id'])
                self.store.release_cooldown(cooldown_key)
            await interaction.edit_original_response(content=result, allowed_mentions=NO_MENTIONS)
            # Someone could have responded while the remaining DMs were being delivered.
            if delivered:
                await self.refresh(session['id'])
        except (SessionError, discord.HTTPException) as exc:
            if delivered == 0:
                if session:
                    self.store.delete(session['id'])
                if cooldown_key:
                    self.store.release_cooldown(cooldown_key)
            text = str(exc) if isinstance(exc, SessionError) else 'Discord could not deliver the invitation. Check the channel permissions.'
            await interaction.edit_original_response(content=text, allowed_mentions=NO_MENTIONS)

    async def refresh(self, sid):
        async with self.refresh_lock:
            session = self.store.get(sid)
            for copy in self.store.copies(sid):
                if copy['revision'] >= session['revision']:
                    continue
                try:
                    channel = self.get_channel(int(copy['channel_id'])) or await self.fetch_channel(int(copy['channel_id']))
                    message = channel.get_partial_message(int(copy['message_id']))
                    # Clear legacy content/embeds when an older invitation is upgraded to V2.
                    await message.edit(content=None, embeds=[], attachments=[],
                                       view=SessionView(self, session), allowed_mentions=NO_MENTIONS)
                    self.store.mark_copy(copy['message_id'], session['revision'])
                except discord.NotFound:
                    self.store.remove_copy(copy['message_id'])
                except discord.HTTPException as exc:
                    # Keep the old revision; maintenance will retry after a temporary failure.
                    LOG.warning('Card update deferred (%s).', type(exc).__name__)

    async def update_population(self, session):
        if self.server_tracker is None:
            return
        try:
            population = await self.server_tracker.population(session['join_url'])
        except ServerUnavailable:
            # Do not present stale or guessed data as a live player count.
            population = {'status': 'unavailable', 'players': None, 'capacity': None}
        self.store.set_population(session['id'], population)

    @tasks.loop(seconds=5)
    async def maintenance(self):
        try:
            self.store.expire()
            if time.monotonic() - self.last_population_check >= 30:
                for session in self.store.all():
                    if self.store.copies(session['id']):
                        await self.update_population(session)
                self.last_population_check = time.monotonic()
            for session in self.store.all():
                if any(c['revision'] < session['revision'] for c in self.store.copies(session['id'])):
                    await self.refresh(session['id'])
        except Exception as exc:
            LOG.error('Maintenance failed (%s); retrying next cycle.', type(exc).__name__)

    @maintenance.before_loop
    async def before_maintenance(self):
        await self.wait_until_ready()

    async def close(self):
        self.maintenance.cancel()
        if self.http_session:
            await self.http_session.close()
        await super().close()


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Validate local config without connecting to Discord.')
    args = parser.parse_args()
    config = load_config()
    if args.check:
        print('Configuration is valid. Games: ' + ', '.join(config['games']))
        print('No Discord connection or messages were made.')
        return
    token, guild_id, channel_id = credentials()
    directory = Path(os.getenv('DATA_DIR', str(ROOT / 'data')))
    store = Store(directory / 'attendance.sqlite3')
    bot = HopBot(config, guild_id, channel_id, store)
    try:
        bot.run(token, log_handler=None)
    finally:
        store.close()


if __name__ == '__main__':
    main()
