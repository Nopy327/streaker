# Set up Fumo Hop

You need a Discord account that can add a bot to your server, this project folder, and somewhere to keep Python running. Start on your own computer, then move it to a host if you want it online while your computer is off.

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, and give it a name.
2. Open **Bot**. Create the bot if prompted, then use **Reset Token** / **Copy** to get its token. Put it in your local `.env` file below. Treat it like a password; never commit it or paste it in a Discord channel.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent**. This lets names such as `loogi ori` resolve to your server's members. Message Content and Presence intents are unnecessary.
4. Under **Installation**, enable **Guild Install**, select the `bot` and `applications.commands` scopes, and grant **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, and **Mention Everyone**.
5. Open the installation link, choose your Discord server, and add the bot. You can also use **OAuth2 → URL Generator** with those scopes and permissions.

This bot receives interactions through Discord's Gateway; leave the **Interactions Endpoint URL** empty. [Discord app setup](https://docs.discord.com/developers/quick-start/getting-started), [Gateway intents](https://docs.discord.com/developers/events/gateway#privileged-intents).

## 2. Copy your server and channel IDs

In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your server icon and choose **Copy Server ID**. Right-click the channel where public pings should go and choose **Copy Channel ID**.

Choose the ping channel, not the view-only player-list channel. The bot posts public invitations only in the configured channel, even when someone invokes the command elsewhere in the server.

Check the ping channel's permission overrides: the bot needs the permissions listed above there. Members need access to the channel and **Use Application Commands** wherever they invoke commands.

By default, public hops can be started by people who have **Mention @everyone** in the target channel or **Manage Server**. To allow a separate role to start hops, copy that role's ID into `config.json`:

```json
"public_role_ids": ["YOUR_ROLE_ID"]
```

An empty list keeps the default permission check. Private invitations are available to server members who can use the command. Public and private command cooldowns are disabled (`0` in `config.json`), so you can run commands repeatedly. This also clears any previously saved command timer when you next use the command. Attendance still closes after one hour.

## 3. Fill in the configuration

Make a copy of `.env.example` named `.env` in the same folder as `bot.py`. Replace the first three values:

```dotenv
DISCORD_TOKEN=your_actual_bot_token
DISCORD_GUILD_ID=your_server_id
HOP_CHANNEL_ID=your_ping_channel_id
DATA_DIR=./data
```

Use a plain text editor. On macOS, files starting with a dot may be hidden; Command–Shift–Period shows them in Finder. Make sure the filename is `.env`, not `.env.txt`.

The game IDs are already populated from the Roblox pages for [Become Fumo](https://www.roblox.com/games/6238705697/Become-Fumo) and [Scuffed Become Fumo](https://www.roblox.com/games/7363647365/Scuffed-Become-Fumo). Both use `single_server` mode. You do not need a Roblox token, cookie, or game ownership for this mode.

## 4. Run it on your computer

Install [Python](https://www.python.org/downloads/); Python 3.12 is the recommended version for this project. Open a terminal in the extracted `fumo-hop` folder.

On macOS or Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
```

Skip the `cp` command if you already filled in `.env`. Fill it in now if you have just copied it, then run:

```sh
.venv/bin/python bot.py --check
.venv/bin/python check_servers.py
.venv/bin/python bot.py
```

On Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Skip `Copy-Item` if you already filled in `.env`. After editing `.env`, run:

```powershell
.\.venv\Scripts\python.exe bot.py --check
.\.venv\Scripts\python.exe check_servers.py
.\.venv\Scripts\python.exe bot.py
```

`--check` validates the local configuration without logging in. `check_servers.py` reads Roblox's servers and sends no Discord messages. Starting `bot.py` logs into Discord and registers the two commands in your chosen server; it does not send an invitation until someone invokes a command.

Leave the terminal open. Press Ctrl+C to stop. When the computer sleeps, shuts down, or loses its connection, the bot goes offline. Saved deadlines still apply on its next start.

## 5. Use and test it

Discord slash commands use option fields. Type `/advanced hop`, select `game`, choose `bf` or `sbf`, then optionally fill `private`.

```text
/hop
/advanced hop game:bf
/advanced hop game:sbf
/advanced hop game:sbf private:loogi ori
```

For a quiet first test, use `private` with one friend who has agreed to test. Both of you should receive a separate DM with the same list. Only the command sender sees the command confirmation. A public `/hop` really does ping everyone in the configured channel.

Click **I'm coming** once to add yourself to the attendance list, or click it again to remove yourself. No popup or confirmation is needed. The sender is counted automatically. The card displays the shared attendee list and updates all invitations.

Stop and restart the bot during the hour; existing cards continue working. At one hour, no more additions or removals are accepted. The disabled button and closed state normally appear within five seconds of the deadline. All saved cards are also repainted in place when the bot starts, with no additional public ping.

There is deliberately **no Join game link or button**. Discord does not provide a guaranteed one-click action that opens Roblox directly in the correct server. The bot can still detect a public server to show a separate in-game player count when known; this is not the count of RSVP attendees.

## 6. Make short names work

The private option accepts exact Discord usernames, display names, nicknames, mentions, or user IDs. Names are case-insensitive. Use quotes for names with spaces:

```text
/advanced hop game:bf private:"loogi person" ori
```

If two people share a name, use their Discord mentions. The bot rejects ambiguous names before sending any DMs.

For permanent shortcuts, right-click a user and copy their user ID. Edit the `aliases` section in `config.json`:

```json
"aliases": {
  "loogi": "REPLACE_WITH_LOOGIS_DISCORD_USER_ID",
  "nopy": "REPLACE_WITH_NOPYS_DISCORD_USER_ID",
  "ori": "REPLACE_WITH_ORIS_DISCORD_USER_ID"
}
```

Those uppercase values are placeholders; replace them with the actual numeric IDs. Aliases must refer to members of your server. Restart after editing. Repeat names are counted only once. The sender gets a DM automatically, so you do not need to include yourself.

If someone has blocked the bot or disabled DMs, the command reports who could not be reached. Successfully delivered invitations remain usable. Private invitations do not post anything in the public channel. They also do not create a Roblox private server: other players can still enter a public Roblox server.

## 7. Choose hosting

This bot needs a continuously running Python process and a persistent disk. Run **one instance** of the bot. The SQLite database should stay at the same mounted path across restarts and deployments.

| Place | Suitable setup | Cost guidance |
| --- | --- | --- |
| Your own computer | Run the terminal commands above and keep the machine awake | No hosting subscription; uses your electricity and connection |
| [Railway](https://railway.com/) | Docker service with a volume at `/data` | Hobby has a $5 monthly minimum including $5 of usage; extra usage can cost more |
| [Render](https://render.com/) | Background Worker with persistent disk at `/data` | Smallest listed worker is $7/month, plus disk charges |

Prices were checked November 22, 2026; confirm before buying. Railway's free plan sleeps when idle, and Render's free web service is not the continuous worker used here. [Railway pricing](https://railway.com/pricing), [Render worker plans](https://render.com/docs/compute-plans), [Render pricing](https://render.com/pricing).

### Railway steps

1. Put this project's files in a private GitHub repository. Do not upload `.env`, `data/`, or `.venv/`. If you configure a private Roblox server link, treat that link as an invitation secret too.
2. In Railway, create a project and deploy the GitHub repository. Point the service's root directory at the folder containing `Dockerfile` if needed. Railway can build the included Dockerfile.
3. Add service variables `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `HOP_CHANNEL_ID`, and `DATA_DIR=/data`.
4. Attach a persistent **Volume** mounted at `/data` before the first live run. Keep one replica and disable sleeping/serverless behavior for this always-connected bot.
5. Deploy and read the logs for the login/command-registration message. No public domain or HTTP health-check path is needed.

The volume keeps `attendance.sqlite3` across deployments. If moving from your computer, stop the local bot before starting the hosted one. To preserve existing cards, move the database from your local `data` folder into the mounted volume while both instances are stopped. A fresh empty database cannot restore old invitation buttons. [Railway volumes](https://docs.railway.com/volumes).

### Render steps

1. Upload the project to a private GitHub repository, excluding `.env`, local data, and the virtual environment.
2. In Render choose **New → Background Worker**, connect the repository, and use the included **Dockerfile**. Select the folder containing it as the root if the repository has other files.
3. Choose a worker plan and add a persistent disk mounted at `/data`.
4. Set the same four environment variables listed for Railway, with `DATA_DIR=/data`.
5. Deploy one instance and check its logs. The Dockerfile supplies the start command, `python bot.py`.

Render background workers run continuously without accepting incoming web traffic. Persistent disks keep only files under their mount path, so `DATA_DIR` must point there. [Render workers](https://render.com/docs/background-workers), [Render disks](https://render.com/docs/disks).

For either host, `config.json` can stay in the repository. Alternatively, set `CONFIG_JSON` to the entire JSON object in a private environment variable; it overrides the file. This is useful for aliases or a private server link. Restart or redeploy after changing configuration. Stop the local copy before operating the hosted copy.

## 8. Redesign it later

Edit the `appearance` section in `config.json` to change the title, accent color, attendance-button labels, empty-list text, and optional image URL. `{game}` is available in the title. The card shows an attendee count, names, and (when verified) a separate Roblox player count.

For layout changes, edit `SessionView` in `ui.py`, and for the decorative banner edit `card_art.py`. The one RSVP button lives inside a Components V2 container. Restart the bot to load edits. All saved message copies are refreshed after startup without posting a new ping.

Discord controls the background and native button colors. The card has a mint-green accent and its one RSVP button uses Discord's green style. [Discord containers](https://docs.discord.com/developers/components/reference#container).

## 9. If several Roblox servers become active

The default Roblox server lookup refuses to guess which server to track. The attendance card is still created if detection fails; the command sender sees the reason in their private confirmation. A new `/hop` checks again. No Roblox Join link is shown.

If you get a link to the exact server you want, edit the selected game's entry:

```json
"mode": "link",
"join_url": "PASTE_YOUR_HTTPS_ROBLOX_SERVER_LINK_HERE"
```

Use an actual server/share/private-server link, not just the game's homepage. The link is captured for each invitation. Do not reuse an old public-instance link after that server has shut down. Roblox now recommends share links; this bot also supports its documented instance URL format for automatic server-list lookup. [Roblox link documentation](https://create.roblox.com/docs/production/promotion/deeplinks).

If you later learn Fumocam's Roblox account ID, there is also optional `presence` mode:

```json
"mode": "presence",
"fumocam_user_id": 123456789
```

Replace the example number. This works only if Roblox's unauthenticated presence response exposes the account's current game instance. Hidden/offline/wrong-game presence prevents an exact in-game player count from being shown. This optional mode was tested with simulated responses; it has not been verified against Fumocam's account. No Roblox login cookie is required or bypassed. The `single_server` mode is the current default and was checked against both games' live server lists.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Bot is offline | Process/host is running; token is correct; read startup logs |
| `PrivilegedIntentsRequired` | Enable **Server Members Intent** on the app's Bot page |
| Slash commands do not appear | Correct server ID; bot installed with both scopes; restart Discord; check startup logs |
| Public hop denied | Caller needs Mention @everyone or an allowed role; bot needs target-channel permissions |
| Ping does not notify a particular person | Their Discord notification settings may suppress `@everyone` |
| Private name not found | Use a Discord mention or configure an alias; names must match exactly |
| DM delivery failed | Recipient must permit DMs from this bot |
| In-game player count is missing | The target Roblox instance could not be confirmed; RSVP still works |
| Old buttons stop working after redeploy | Ensure `/data` is persistent and contains the original database |
| “Interaction failed” after a restart | Confirm the bot is running; the RSVP button has no popup |

For development checks, run `python -m unittest discover -s tests -v` using your virtual environment's Python. No real Discord messages are sent by the tests.
