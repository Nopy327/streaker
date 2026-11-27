import re
import shlex

from store import SessionError


def resolve_recipients(text, members, aliases, host, limit):
    """Exact matches only: ambiguous nicknames must never receive an accidental DM."""
    try:
        tokens = shlex.split(text.replace(',', ' '))
    except ValueError as exc:
        raise SessionError('Close any quotes around names, or use Discord mentions.') from exc
    if not tokens:
        raise SessionError('Choose at least one person in the private option.')
    by_id = {str(member.id): member for member in members}
    selected = {}
    for token in tokens:
        match = re.fullmatch(r'<@!?(\d+)>|(\d{15,22})', token)
        uid = next((x for x in match.groups() if x), None) if match else aliases.get(token.casefold())
        if uid is not None:
            matches = [by_id[str(uid)]] if str(uid) in by_id else []
        else:
            name = token.removeprefix('@').casefold()
            matches = [m for m in members if name in {
                m.name.casefold(), m.display_name.casefold(),
                (getattr(m, 'global_name', None) or '').casefold(),
            }]
        if not matches:
            raise SessionError(f'No server member matches {token!r}. Use their Discord mention or add an alias.')
        if len(matches) != 1:
            raise SessionError(f'More than one member matches {token!r}. Use a Discord mention.')
        member = matches[0]
        if member.bot:
            raise SessionError('Private invitations must be sent to people, not bot accounts.')
        selected[str(member.id)] = member
    selected.pop(str(host.id), None)
    if not selected:
        raise SessionError('Choose at least one person other than yourself.')
    if len(selected) > limit:
        raise SessionError(f'Choose at most {limit} other people.')
    return [host, *selected.values()]
