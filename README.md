# Streaker — Local Streak Tracker

## Source repository and private data

This repository contains the app, Discord bot, and tests. The `.discord-bot/`
directory is intentionally excluded: it contains the bot token, Discord account
links, saved card data, spectator access codes, and uploaded files. Environment
files, logs, backups, dependencies, and generated builds are excluded too.
Never force-add these files to Git.

Cloning this repository does not restore live records or the bot token. Keep
private backups separately. The launchers below use this Mac's existing runtime
paths; publishing the source does not change its startup services.

## Running on the existing Mac

The local website and Discord companion start automatically when you sign in
to this Mac. Open `http://localhost:3210`, or double-click **Start Streak
Tracker.command** to open it. If the launcher has to start a stopped website
itself, keep that launcher window open while using the app.

## What the app tracks

- Nopy streak days that complete at exactly 22:05 Europe/Berlin
- Void streak days that complete at exactly 22:05 Brazil (São Paulo)
- A live countdown to each person’s next cutoff
- 90-day progress and Bronze, Silver, Gold, Diamond, and Platinum milestones
- X-Rate totals using the current and previous streak-day windows, labeled
  Today and Yesterday for the local date each window ends. They roll at 22:05
  in that person's timezone; windows with no saved value count as zero
- A blank text box under X-Rate, editable through the card's Edit button
- One optional GIF per card, attached in Edit and shown as a still thumbnail
  and filename at the bottom of that text box
- A website tab icon that can be changed or reset from any card's Edit window;
  the choice is saved in that browser
- Editable completed days that automatically recalculate progress and medals,
  then continue advancing at the next cutoff

Occurrence records stay on this Mac. The browser keeps the editable source and,
while the companion is running, mirrors it to a private local file used to make
the Discord card. If the box has text, the bot sends it unchanged as a separate
DM immediately after the card; it is not drawn on the card image. If a GIF is
attached, the bot sends the animated GIF as a third DM after the text (or
directly after the card when the text box is empty). GIF files stay in the
private local companion folder.

Older occurrence totals were stored by calendar date. They remain on their
saved dates; without occurrence times, they cannot be split precisely around
22:05.

## Discord daily cards

Double-click **Configure Discord Bot.command** once and enter the bot token. The
token is stored in a private, ignored file on this Mac and is never placed in
the browser or shared with friends.

On Discord's Installation page, enable **User Install**, select the
`applications.commands` scope, and use a Discord Provided Link. No shared
server is required. Each friend installs that link to their own account, opens
a DM with the app, and can use these commands while **Start Streak
Tracker.command** is running:

- `/connect card:` — privately link their account to an available card
- `/status` — receive their current horizontal card, saved text, and GIF by DM
- `/disconnect` — stop future reports and free the card for someone else

Only one Discord account can claim each card. Command confirmations are private.

Each linked horizontal card is sent shortly after that person's local 22:05
cutoff, followed by any saved text and GIF. Keep **Start Streak Tracker.command** running;
if the Mac is asleep or offline at the cutoff, the latest missed report is sent
after the app starts again. Use **Send Discord Test Card.command** to verify the
DM setup.
