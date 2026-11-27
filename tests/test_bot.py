import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import discord

from bot import HopBot
from recipients import resolve_recipients
from roblox import PublicServerTracker, ServerUnavailable, resolve_server, validate_link
from settings import load_config
from store import SessionError, Store
from ui import SessionView


def member(uid, name, display=None):
    return SimpleNamespace(id=uid, name=name, display_name=display or name, global_name=None, bot=False)


def new_session(store, now=100, recipients=None):
    return store.create(1, 'bf', 'Become Fumo', 10, 'nopy', recipients,
                        'https://www.roblox.com/games/start?placeId=6238705697&gameInstanceId=abc',
                        'Selected server.', now=now)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')

    def tearDown(self):
        self.store.close()

    def test_check_uncheck_and_duplicate_submit(self):
        s = new_session(self.store)
        sid = s['id']
        self.assertEqual(s['attendees'], {'10': 'nopy'})
        self.store.vote(sid, 20, 'ori', True, now=101)
        self.store.vote(sid, 20, 'ori', True, now=102)
        self.assertEqual(len(self.store.get(sid)['attendees']), 2)
        self.assertEqual(self.store.get(sid)['revision'], 2)
        self.store.vote(sid, 20, 'ori', False, now=103)
        self.assertEqual(self.store.get(sid)['attendees'], {'10': 'nopy'})

    def test_exact_deadline_rejects_add_and_remove_before_sweeper(self):
        s = new_session(self.store)
        self.store.vote(s['id'], 20, 'ori', True, now=3699.999)
        for uid, value in [(30, True), (20, False)]:
            with self.assertRaisesRegex(SessionError, 'closed'):
                self.store.vote(s['id'], uid, 'name', value, now=3700)
        self.store.expire(now=3700)
        self.assertTrue(self.store.get(s['id'])['locked'])
        self.store.expire(now=5000)
        self.assertEqual(self.store.get(s['id'])['revision'], 3)

    def test_private_list_rejects_outsider(self):
        s = new_session(self.store, recipients=['10', '20'])
        with self.assertRaisesRegex(SessionError, 'private'):
            self.store.vote(s['id'], 30, 'stranger', True, now=200)
        self.store.vote(s['id'], 20, 'ori', True, now=200)
        self.assertEqual(len(self.store.get(s['id'])['attendees']), 2)

    def test_votes_preserve_all_dm_message_copies(self):
        s = new_session(self.store, recipients=['10', '20'])
        self.store.add_copy(s['id'], 100, 200, 1)
        self.store.add_copy(s['id'], 101, 201, 1)
        self.store.vote(s['id'], 20, 'ori', True, now=200)
        self.assertEqual(len(self.store.copies(s['id'])), 2)
        self.assertTrue(all(c['revision'] < self.store.get(s['id'])['revision']
                            for c in self.store.copies(s['id'])))

    def test_repaint_scheduled_without_changing_attendance(self):
        s = new_session(self.store)
        self.store.add_copy(s['id'], 101, 201, s['revision'])
        self.store.invalidate_copies()
        self.assertEqual(self.store.copies(s['id'])[0]['revision'], 0)
        self.assertEqual(self.store.get(s['id'])['attendees'], {'10': 'nopy'})

    def test_restart_retains_votes_message_and_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'db.sqlite3'
            first = Store(path)
            s = new_session(first)
            first.vote(s['id'], 20, 'ori', True, now=200)
            first.add_copy(s['id'], 111, 222, 1)
            first.close()
            second = Store(path)
            second.expire(now=4000)
            self.assertTrue(second.get(s['id'])['locked'])
            self.assertEqual(len(second.get(s['id'])['attendees']), 2)
            self.assertEqual(second.copies(s['id'])[0]['message_id'], '222')
            second.close()

    def test_cooldown_is_persistent_and_releasable(self):
        self.store.reserve_cooldown('public', 300, now=100)
        with self.assertRaises(SessionError):
            self.store.reserve_cooldown('public', 300, now=101)
        self.store.reserve_cooldown('public', 300, now=400)
        self.store.release_cooldown('public')
        self.store.reserve_cooldown('public', 300, now=401)

    def test_disabling_cooldown_cancels_existing_timer_and_allows_repeats(self):
        for key in ('public:1', 'private:1:10'):
            self.store.reserve_cooldown(key, 300, now=100)
            self.store.reserve_cooldown(key, 0, now=101)
            self.store.reserve_cooldown(key, 0, now=101)
            self.assertIsNone(self.store.db.execute(
                'SELECT until FROM cooldowns WHERE key=?', (key,)).fetchone())


class RecipientTests(unittest.TestCase):
    def setUp(self):
        self.host = member(100000000000000001, 'nopy')
        self.loogi = member(100000000000000002, 'luigi', 'loogi')
        self.ori = member(100000000000000003, 'ori')
        self.people = [self.host, self.loogi, self.ori]

    def test_names_mentions_and_aliases_deduplicate(self):
        result = resolve_recipients('LOOGI o <@100000000000000003> nopy', self.people,
                                    {'o': str(self.ori.id)}, self.host, 10)
        self.assertEqual(result, self.people)

    def test_ambiguous_name_fails_before_any_dm(self):
        self.people.append(member(100000000000000004, 'other', 'ori'))
        with self.assertRaisesRegex(SessionError, 'More than one'):
            resolve_recipients('ori', self.people, {}, self.host, 10)

    def test_quoted_names(self):
        self.ori.display_name = 'ori person'
        result = resolve_recipients('"ori person"', self.people, {}, self.host, 10)
        self.assertEqual(result, [self.host, self.ori])

    def test_empty_missing_and_bot_rejected(self):
        for value in ['', 'unknown', 'nopy']:
            with self.assertRaises(SessionError):
                resolve_recipients(value, self.people, {}, self.host, 10)
        self.ori.bot = True
        with self.assertRaises(SessionError):
            resolve_recipients('ori', self.people, {}, self.host, 10)


class RobloxTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_server_includes_full_servers_and_paginates(self):
        responses = [{'data': [{'id': 'empty', 'playing': 0}], 'nextPageCursor': 'page2'},
                     {'data': [{'id': 'target', 'playing': 10, 'maxPlayers': 10}], 'nextPageCursor': None}]
        with patch('roblox.get_json', new=AsyncMock(side_effect=responses)) as fetch:
            url, _ = await resolve_server({'mode': 'single_server', 'place_id': 123}, None)
        self.assertIn('gameInstanceId=target', url)
        self.assertEqual(fetch.call_args_list[0].kwargs['params']['excludeFullGames'], 'false')
        self.assertEqual(fetch.call_args_list[1].kwargs['params']['cursor'], 'page2')

    async def test_multiple_servers_never_guess(self):
        with patch('roblox.get_json', new=AsyncMock(return_value={'data': [
            {'id': 'one', 'playing': 20}, {'id': 'two', 'playing': 1}]})):
            with self.assertRaisesRegex(ServerUnavailable, 'Several'):
                await resolve_server({'mode': 'single_server', 'place_id': 123}, None)

    async def test_none_and_incomplete_scan_do_not_fallback(self):
        for payload in [{'data': []}, {'data': [{'id': 'one', 'playing': 1}], 'nextPageCursor': 'more'}]:
            with patch('roblox.get_json', new=AsyncMock(return_value=payload)):
                with self.assertRaises(ServerUnavailable):
                    await resolve_server({'mode': 'single_server', 'place_id': 123}, None)

    async def test_hidden_presence_is_not_treated_as_exact_server(self):
        data = {'userPresences': [{'userId': 99, 'userPresenceType': 2, 'placeId': 123, 'gameId': ''}]}
        with patch('roblox.get_json', new=AsyncMock(return_value=data)):
            with self.assertRaisesRegex(ServerUnavailable, 'hiding'):
                await resolve_server({'mode': 'presence', 'place_id': 123, 'fumocam_user_id': 99}, None)

    async def test_presence_targets_reported_instance(self):
        data = {'userPresences': [{'userId': 99, 'userPresenceType': 2, 'placeId': 123, 'gameId': 'job'}]}
        with patch('roblox.get_json', new=AsyncMock(return_value=data)):
            url, _ = await resolve_server({'mode': 'presence', 'place_id': 123, 'fumocam_user_id': 99}, None)
        self.assertIn('gameInstanceId=job', url)

    def test_untrusted_link_rejected(self):
        for url in ['http://www.roblox.com/share', 'https://roblox.com.evil.example/share',
                    'https://roblox.com@evil.example/share', 'javascript:alert(1)']:
            with self.assertRaises(ServerUnavailable):
                validate_link(url)


class DiscordTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.config = load_config()
        self.store = Store(':memory:')
        self.bot = HopBot(self.config, 1, 2, self.store)

    async def asyncTearDown(self):
        await self.bot.close()
        self.store.close()

    async def test_registered_command_shape(self):
        commands = self.bot.tree.get_commands(guild=discord.Object(id=1))
        self.assertEqual({c.name for c in commands}, {'hop', 'advanced'})
        advanced = next(c for c in commands if c.name == 'advanced')
        payload = advanced.to_dict(self.bot.tree)
        options = payload['options'][0]['options']
        self.assertEqual([x['name'] for x in options], ['game', 'private'])
        self.assertEqual([x['value'] for x in options[0]['choices']], ['bf', 'sbf'])
        self.assertFalse(options[1]['required'])

    async def test_persistent_emoji_free_buttons(self):
        s = new_session(self.store, now=4000000000)
        view = SessionView(self.bot, s)
        self.assertTrue(view.is_persistent())
        for item in view.walk_children():
            if isinstance(item, discord.ui.Button):
                self.assertIsNone(item.emoji)

    async def test_frozen_card_disables_rsvp_and_never_shows_join_link(self):
        s = new_session(self.store)
        view = SessionView(self.bot, s)
        buttons = [item for item in view.walk_children() if isinstance(item, discord.ui.Button)]
        self.assertEqual(len(buttons), 1)
        self.assertTrue(buttons[0].disabled)
        payload = json.dumps(view.to_components())
        self.assertIn('Final attendance list', payload)
        self.assertNotIn(s['join_url'], payload)
        self.assertNotIn('Join game', payload)

    async def test_redesigned_card_has_one_rsvp_button_and_clear_attendance(self):
        s = new_session(self.store, now=4000000000)
        s['population'] = {'status': 'live', 'players': 7, 'capacity': 20}
        payload = SessionView(self.bot, s).to_components()
        self.assertEqual(payload[0]['content'], '@everyone')
        card = payload[1]
        self.assertEqual(card['type'], 17)
        self.assertEqual(card['accent_color'], 0x34D399)
        children = card['components']
        self.assertEqual(children[0]['type'], 12)
        self.assertEqual(children[0]['items'][0]['media']['url'], 'attachment://hop-banner.png')
        text = json.dumps(payload)
        self.assertIn('FUMO HOP', text)
        self.assertIn('01 attending', text)
        self.assertIn('IN-GAME RIGHT NOW', text)
        self.assertIn('7 / 20 players', text)
        self.assertIn('Registration closes', text)
        self.assertIn('Attendee list', text)
        rows = [c for c in children if c['type'] == 1]
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]['components']), 1)
        self.assertEqual(rows[0]['components'][0]['label'], "I'm coming")
        self.assertEqual(rows[0]['components'][0]['style'], 3)
        self.assertNotIn(s['join_url'], text)
        self.assertNotIn('Join game', text)
        profiles = [c for c in children if c['type'] == 9]
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['accessory']['type'], 11)

    async def test_private_card_never_pings_and_does_not_contain_join_link(self):
        s = new_session(self.store, now=4000000000, recipients=['10', '20'])
        text = json.dumps(SessionView(self.bot, s).to_components())
        self.assertIn('PRIVATE INVITATION', text)
        self.assertNotIn('@everyone', text)
        self.assertNotIn(s['join_url'], text)

    async def test_v2_wire_payload_sets_flag_and_omits_legacy_embed(self):
        from discord.http import handle_message_parameters
        s = new_session(self.store, now=4000000000)
        with handle_message_parameters(view=SessionView(self.bot, s),
                                       allowed_mentions=discord.AllowedMentions(everyone=True)) as params:
            self.assertEqual(params.payload['flags'] & (1 << 15), 1 << 15)
            self.assertNotIn('embeds', params.payload)
            self.assertNotIn('content', params.payload)
            self.assertIn('everyone', params.payload['allowed_mentions']['parse'])

    async def test_large_roster_stays_inside_discord_limits(self):
        s = new_session(self.store)
        s['attendees'] = {str(i): '*' * 100 for i in range(200)}
        view = SessionView(self.bot, s)
        self.assertIn('+ 195 more attending', json.dumps(view.to_components()))
        self.assertLessEqual(view.total_children_count, 40)
        self.assertLessEqual(view.content_length(), 4000)

    async def test_failed_update_remains_dirty_for_retry_and_never_re_pings(self):
        s = new_session(self.store, now=4000000000)
        self.store.add_copy(s['id'], 200, 300, 0)
        response = SimpleNamespace(status=503, reason='Unavailable')
        msg = SimpleNamespace(edit=AsyncMock(side_effect=[discord.HTTPException(response, 'temporary'), None]))
        channel = SimpleNamespace(get_partial_message=lambda _: msg)
        with patch.object(self.bot, 'get_channel', return_value=channel):
            await self.bot.refresh(s['id'])
            self.assertEqual(self.store.copies(s['id'])[0]['revision'], 0)
            await self.bot.refresh(s['id'])
        self.assertEqual(self.store.copies(s['id'])[0]['revision'], 1)
        kwargs = msg.edit.call_args.kwargs
        self.assertIsNone(kwargs['content'])
        self.assertEqual(kwargs['embeds'], [])
        self.assertEqual(kwargs['attachments'][0].filename, 'hop-banner.png')
        self.assertEqual(kwargs['allowed_mentions'].to_dict()['parse'], [])

    def interaction(self):
        caller = MagicMock(spec=discord.Member)
        caller.id, caller.display_name = 10, 'nopy'
        caller.roles = []
        caller.send = AsyncMock(return_value=SimpleNamespace(id=101, channel=SimpleNamespace(id=201)))
        interaction = SimpleNamespace(
            guild_id=1, user=caller, guild=SimpleNamespace(chunked=True, members=[caller]),
            response=SimpleNamespace(defer=AsyncMock()), edit_original_response=AsyncMock(),
        )
        return interaction

    async def test_public_command_pings_assigned_channel_once(self):
        self.config['public_cooldown_seconds'] = 300
        interaction = self.interaction()
        message = SimpleNamespace(id=300, channel=SimpleNamespace(id=2), jump_url='https://discord.com/channels/1/2/300')
        channel = SimpleNamespace(send=AsyncMock(return_value=message), mention='<#2>')
        with patch.object(self.bot, 'target_channel', new=AsyncMock(return_value=channel)), \
             patch('bot.resolve_server', new=AsyncMock(return_value=('https://www.roblox.com/share?code=test&type=Server', 'Selected server.'))):
            await self.bot.create_hop(interaction, 'bf', None)
            await self.bot.create_hop(interaction, 'bf', None)
        self.assertEqual(channel.send.await_count, 1)
        kwargs = channel.send.call_args.kwargs
        self.assertEqual(kwargs['view'].to_components()[0]['content'], '@everyone')
        self.assertTrue(kwargs['allowed_mentions'].everyone)
        self.assertNotIn('embed', kwargs)
        self.assertEqual(len(self.store.all()), 1)

    async def test_private_dms_share_list_and_partial_failure_is_reported(self):
        interaction = self.interaction()
        loogi = member(20, 'loogi')
        ori = member(30, 'ori')
        loogi.send = AsyncMock(return_value=SimpleNamespace(id=102, channel=SimpleNamespace(id=202)))
        ori.send = AsyncMock(side_effect=discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'closed'))
        interaction.guild.members += [loogi, ori]
        interaction.user.name = 'nopy'
        interaction.user.global_name = None
        interaction.user.bot = False
        with patch.object(self.bot, 'target_channel', new=AsyncMock()) as public, \
             patch('bot.resolve_server', new=AsyncMock(return_value=('https://www.roblox.com/share?code=test&type=Server', 'Selected server.'))):
            await self.bot.create_hop(interaction, 'sbf', 'loogi ori')
        public.assert_not_called()
        s = self.store.all()[0]
        self.assertEqual(s['recipients'], ['10', '20', '30'])
        self.assertEqual(len(self.store.copies(s['id'])), 2)
        self.assertIn('Could not DM: ori', interaction.edit_original_response.call_args.kwargs['content'])
        self.assertNotIn('content', loogi.send.call_args.kwargs)
        self.assertNotIn('@everyone', json.dumps(loogi.send.call_args.kwargs['view'].to_components()))

    async def test_no_dm_delivery_releases_cooldown_and_removes_session(self):
        interaction = self.interaction()
        interaction.user.name, interaction.user.global_name, interaction.user.bot = 'nopy', None, False
        ori = member(30, 'ori')
        failure = discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'closed')
        interaction.user.send = AsyncMock(side_effect=failure)
        ori.send = AsyncMock(side_effect=failure)
        interaction.guild.members.append(ori)
        with patch('bot.resolve_server', new=AsyncMock(return_value=(None, 'No server.'))):
            await self.bot.create_hop(interaction, 'bf', 'ori')
        self.assertEqual(self.store.all(), [])
        self.store.reserve_cooldown('private:1:10', 60)

    async def test_yes_click_after_deadline_cannot_change_list(self):
        s = new_session(self.store)
        view = SessionView(self.bot, s)
        interaction = self.interaction()
        interaction.user.id = 20
        with patch.object(self.bot, 'authorize_attendance', new=AsyncMock()), \
             patch.object(self.bot, 'private_error', new=AsyncMock()) as error:
            await view.toggle_attendance(interaction)
        self.assertIn('closed', error.call_args.args[1])
        self.assertEqual(self.store.get(s['id'])['attendees'], {'10': 'nopy'})

    async def test_yes_toggles_immediately_without_popup_or_confirmation(self):
        s = new_session(self.store, now=4000000000)
        self.store.set_population(s['id'], {'status': 'live', 'players': 7, 'capacity': 20})
        view = SessionView(self.bot, self.store.get(s['id']))
        interaction = self.interaction()
        interaction.user.id, interaction.user.display_name = 20, 'ori'
        interaction.response.send_modal = AsyncMock()
        with patch.object(self.bot, 'authorize_attendance', new=AsyncMock()), \
             patch.object(self.bot, 'refresh', new=AsyncMock()) as refresh:
            await view.toggle_attendance(interaction)
            self.assertIn('20', self.store.get(s['id'])['attendees'])
            await view.toggle_attendance(interaction)
        self.assertNotIn('20', self.store.get(s['id'])['attendees'])
        self.assertEqual(self.store.get(s['id'])['population']['players'], 7)
        interaction.response.send_modal.assert_not_called()
        interaction.edit_original_response.assert_not_called()
        self.assertEqual(refresh.await_count, 2)

    async def test_live_poll_survives_freeze_and_preserves_votes_during_lookup(self):
        s = new_session(self.store, now=4000000000)
        async def lookup(link):
            self.store.vote(s['id'], 20, 'ori', True)
            return {'status': 'live', 'players': 9, 'capacity': 20}
        self.bot.server_tracker = SimpleNamespace(population=lookup)
        await self.bot.update_population(s)
        result = self.store.get(s['id'])
        self.assertIn('20', result['attendees'])
        self.assertEqual(result['population']['players'], 9)
        self.store.expire(now=5000000000)
        self.bot.server_tracker.population = AsyncMock(return_value={'status': 'live', 'players': 10, 'capacity': 20})
        await self.bot.update_population(self.store.get(s['id']))
        self.assertEqual(self.store.get(s['id'])['population']['players'], 10)
        self.assertTrue(self.store.get(s['id'])['locked'])

    async def test_unchanged_population_does_not_cause_message_edits(self):
        s = new_session(self.store)
        self.bot.server_tracker = SimpleNamespace(population=AsyncMock(return_value={'status': 'live', 'players': 7, 'capacity': 20}))
        await self.bot.update_population(s)
        revision = self.store.get(s['id'])['revision']
        await self.bot.update_population(s)
        self.assertEqual(self.store.get(s['id'])['revision'], revision)
        self.bot.server_tracker.population.side_effect = ServerUnavailable('rate limited')
        await self.bot.update_population(s)
        self.assertEqual(self.store.get(s['id'])['population']['status'], 'unavailable')


class PopulationTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_instance_count_and_shared_cache(self):
        tracker = PublicServerTracker(None)
        response = {'data': [{'id': 'abc', 'playing': 7, 'maxPlayers': 20},
                             {'id': 'other', 'playing': 50, 'maxPlayers': 100}], 'nextPageCursor': None}
        with patch('roblox.get_json', new=AsyncMock(return_value=response)) as fetch:
            result = await tracker.population('https://www.roblox.com/games/start?placeId=123&gameInstanceId=abc')
            await tracker.population('https://www.roblox.com/games/start?placeId=123&gameInstanceId=abc')
            self.assertEqual(result, {'status': 'live', 'players': 7, 'capacity': 20})
            self.assertEqual(fetch.await_count, 1)

    async def test_missing_instance_is_offline_without_switching_to_another(self):
        tracker = PublicServerTracker(None)
        with patch('roblox.get_json', new=AsyncMock(return_value={'data': [{'id': 'other', 'playing': 4}]})):
            result = await tracker.population('https://www.roblox.com/games/start?placeId=123&gameInstanceId=abc')
        self.assertEqual(result['status'], 'offline')
        self.assertIsNone(result['players'])

    async def test_share_link_does_not_claim_game_total_as_server_count(self):
        tracker = PublicServerTracker(None)
        result = await tracker.population('https://www.roblox.com/share?code=test&type=Server')
        self.assertEqual(result['status'], 'unknown')

    async def test_failed_lookup_cached_and_not_reported_as_zero(self):
        tracker = PublicServerTracker(None)
        with patch('roblox.get_json', new=AsyncMock(side_effect=ServerUnavailable('limited'))) as fetch:
            for _ in range(2):
                with self.assertRaises(ServerUnavailable):
                    await tracker.population('https://www.roblox.com/games/start?placeId=123&gameInstanceId=abc')
        self.assertEqual(fetch.await_count, 1)


if __name__ == '__main__':
    unittest.main()
