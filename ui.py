
"""Discord Components V2 presentation for Fumo Hop."""

import logging
import time

import discord

from store import SessionError

LOG = logging.getLogger('fumo.ui')


def safe_name(name):
    """Escape Discord display names safely."""
    return discord.utils.escape_markdown(
        discord.utils.escape_mentions(str(name))
    )[:100]


def population_text(session):
    """Show live Roblox server population when available."""
    population = session.get('population') or {}
    status = population.get('status')

    if status == 'live' and population.get('players') is not None:
        players = population['players']
        capacity = population.get('capacity')

        count = (
            f'{players} / {capacity}'
            if capacity else str(players)
        )

        return f'-# IN-GAME RIGHT NOW  ·  {count} players'

    if status == 'offline':
        return '-# IN-GAME RIGHT NOW  ·  Server offline'

    return None


def avatar_url(bot, session):
    """Get the invitation creator's Discord profile picture."""
    user_id = int(session['host_id'])
    guild = bot.get_guild(int(session['guild_id']))

    member = guild.get_member(user_id) if guild else None
    user = member or bot.get_user(user_id)

    if user:
        return str(user.display_avatar.url)

    return (
        'https://cdn.discordapp.com/embed/avatars/'
        f'{(user_id >> 22) % 6}.png'
    )


class SessionView(discord.ui.LayoutView):

    def __init__(self, bot, session):
        super().__init__(timeout=None)

        self.bot = bot
        self.sid = session['id']

        appearance = bot.config['appearance']

        closed = (
            session['locked']
            or time.time() >= session['expires_at']
        )

        private = session['recipients'] is not None
        count = len(session['attendees'])

        # Public notification
        if not private:
            self.add_item(
                discord.ui.TextDisplay('@everyone')
            )

        # Main card
        card = discord.ui.Container(
            accent_color=int(
                appearance['color'].lstrip('#'), 16
            ),
        )

        title = appearance['title'].format(
            game=session['game_name']
        )[:256]

        state_text = 'CLOSED' if closed else 'OPEN'

        # Title and original Discord profile picture
        card.add_item(
            discord.ui.Section(
                discord.ui.TextDisplay(
                    f'# {title}\n-# {state_text}'
                ),
                accessory=discord.ui.Thumbnail(
                    avatar_url(bot, session),
                    description='Host profile picture'
                )
            )
        )

        # Roblox server information
        server_line = population_text(session)

        if server_line:
            card.add_item(
                discord.ui.TextDisplay(server_line)
            )

        # Compact decorative participant counter
        names = [
            safe_name(name)
            for name in session['attendees'].values()
        ]

        rows = [
            " · ".join(names[i:i + 4])
            for i in range(0, len(names), 4)
        ]

        count_line = f"{count:02d} joined users"

        attendee_text = (
            count_line + "\n" + "\n".join(rows)
            if rows else count_line + "\nNo users yet."
        )

        card.add_item(
            discord.ui.TextDisplay(attendee_text)
        )

        # Join attendance button
        button = discord.ui.Button(
            label=(
                appearance['locked_button']
                if closed
                else appearance['attendance_button']
            ),
            custom_id=f'attendance:{self.sid}',
            style=discord.ButtonStyle.success,
            disabled=closed,
        )

        button.callback = self.toggle_attendance

        card.add_item(
            discord.ui.ActionRow(button)
        )

        self.add_item(card)

    async def toggle_attendance(self, interaction):
        await interaction.response.defer()

        try:
            await self.bot.authorize_attendance(
                self.sid,
                interaction.user.id
            )

            session = self.bot.store.get(self.sid)

            checked = (
                str(interaction.user.id)
                not in session['attendees']
            )

            self.bot.store.vote(
                self.sid,
                interaction.user.id,
                interaction.user.display_name,
                checked
            )

        except SessionError as exc:
            await self.bot.private_error(
                interaction,
                str(exc)
            )
            return

        await self.bot.refresh(self.sid)

    async def on_error(self, interaction, error, item):
        LOG.error(
            'Session button failed: %s',
            type(error).__name__
        )

        await self.bot.private_error(
            interaction,
            'This action failed. Please try again.'
        )
