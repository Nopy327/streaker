import assert from 'node:assert/strict';
import test from 'node:test';

import { createNoteMessagePayload } from '../scripts/discord-note.mjs';

test('separate text message preserves spaces, line breaks, and punctuation', () => {
  const note = '  First  line\n\n   second line  ';
  const payload = createNoteMessagePayload(note, 'same-report-text');

  assert.equal(payload.content, note);
  assert.equal(payload.nonce, 'same-report-text');
  assert.equal(payload.enforce_nonce, true);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.flags, 4);
});

test('an empty text box does not create an extra message', () => {
  assert.equal(createNoteMessagePayload(''), null);
});
