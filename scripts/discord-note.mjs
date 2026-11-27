// Keep the saved card text byte-for-byte in the Discord message payload.
// Discord itself may apply its normal message rendering, but we do not trim,
// wrap, prefix, or otherwise rewrite the user's text.
export function createNoteMessagePayload(note, nonce = null) {
  if (note === '') return null;
  return {
    content: note,
    ...(nonce ? { nonce, enforce_nonce: true } : {}),
    allowed_mentions: { parse: [] },
    flags: 1 << 2, // SUPPRESS_EMBEDS
  };
}
