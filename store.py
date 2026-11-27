"""SQLite-backed attendance. Every write is synchronous and transactional."""
import json
import sqlite3
import time
import uuid
from pathlib import Path

HOUR = 3600


class SessionError(ValueError):
    pass


class Store:
    def __init__(self, path):
        if str(path) != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS copies (
                message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cooldowns (
                key TEXT PRIMARY KEY, until REAL NOT NULL
            );
        ''')

    def close(self):
        self.db.close()

    def save(self, session):
        with self.db:
            self.db.execute('INSERT INTO sessions VALUES (?, ?) '
                            'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
                            (session['id'], json.dumps(session)))

    def get(self, sid):
        row = self.db.execute('SELECT payload FROM sessions WHERE id=?', (sid,)).fetchone()
        if row is None:
            raise SessionError('This attendance list is no longer available.')
        return json.loads(row['payload'])

    def all(self):
        return [json.loads(x[0]) for x in self.db.execute('SELECT payload FROM sessions')]

    def create(self, guild_id, game, game_name, host_id, host_name, recipients, join_url,
               join_note, now=None):
        now = time.time() if now is None else now
        sid = uuid.uuid4().hex
        host = str(host_id)
        session = dict(id=sid, guild_id=str(guild_id), game=game, game_name=game_name,
                       host_id=host, host_name=host_name, recipients=recipients,
                       attendees={host: host_name}, created_at=now, expires_at=now + HOUR,
                       locked=False, revision=1, join_url=join_url, join_note=join_note)
        self.save(session)
        return session

    def delete(self, sid):
        with self.db:
            self.db.execute('DELETE FROM sessions WHERE id=?', (sid,))

    def authorize(self, session, user_id):
        recipients = session['recipients']
        if recipients is not None and str(user_id) not in recipients:
            raise SessionError('This is a private invitation for other members.')

    def vote(self, sid, user_id, name, checked, now=None):
        now = time.time() if now is None else now
        session = self.get(sid)
        self.authorize(session, user_id)
        if session['locked'] or now >= session['expires_at']:
            raise SessionError('Attendance is closed. The list is final.')
        uid = str(user_id)
        before = dict(session['attendees'])
        if checked:
            session['attendees'][uid] = name
        else:
            session['attendees'].pop(uid, None)
        if before != session['attendees']:
            session['revision'] += 1
            self.save(session)
        return session

    def set_population(self, sid, population):
        # Always reload after a network lookup, so concurrent Yes clicks are preserved.
        session = self.get(sid)
        if session.get('population') != population:
            session['population'] = population
            session['revision'] += 1
            self.save(session)
        return session

    def expire(self, now=None):
        now = time.time() if now is None else now
        for session in self.all():
            if not session['locked'] and now >= session['expires_at']:
                session['locked'] = True
                session['revision'] += 1
                self.save(session)

    def add_copy(self, sid, channel_id, message_id, revision):
        with self.db:
            self.db.execute('INSERT INTO copies VALUES (?, ?, ?, ?)',
                            (str(message_id), str(channel_id), sid, revision))

    def copies(self, sid):
        return list(self.db.execute('SELECT * FROM copies WHERE session_id=?', (sid,)))

    def invalidate_copies(self):
        """Schedule an in-place visual refresh of all saved Discord cards on startup."""
        with self.db:
            self.db.execute('UPDATE copies SET revision=0')

    def mark_copy(self, message_id, revision):
        with self.db:
            self.db.execute('UPDATE copies SET revision=? WHERE message_id=?',
                            (revision, str(message_id)))

    def remove_copy(self, message_id):
        with self.db:
            self.db.execute('DELETE FROM copies WHERE message_id=?', (str(message_id),))

    def reserve_cooldown(self, key, seconds, now=None):
        if seconds <= 0:
            # Disabling the cooldown also cancels a timer saved by an earlier run.
            self.release_cooldown(key)
            return
        now = time.time() if now is None else now
        row = self.db.execute('SELECT until FROM cooldowns WHERE key=?', (key,)).fetchone()
        if row and row['until'] > now:
            raise SessionError(f'Try again in {int(row["until"] - now) + 1} seconds.')
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO cooldowns VALUES (?, ?)', (key, now + seconds))

    def release_cooldown(self, key):
        with self.db:
            self.db.execute('DELETE FROM cooldowns WHERE key=?', (key,))
