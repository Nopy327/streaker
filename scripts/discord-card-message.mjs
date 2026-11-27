import { createCardModel, renderStreakCardPng } from './discord-card.mjs';

// Shared by owner and spectator deliveries. Notes and other attachments are
// separate owner-only messages, never part of this image message.
export async function createCardImageMessage({
  personId,
  trackerState,
  now = new Date(),
  backgroundDataUri = null,
  nonce = null,
}) {
  const model = createCardModel(personId, trackerState, now);
  const fileName = `${personId}-streak-${model.cutoffKey}.png`;
  const png = await renderStreakCardPng(personId, trackerState, now, backgroundDataUri);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    content: `${model.name} — Day ${model.day} Ongoing`,
    ...(nonce ? { nonce, enforce_nonce: true } : {}),
    allowed_mentions: { parse: [] },
    attachments: [{
      id: 0,
      filename: fileName,
      description: `${model.name} horizontal streak card for ${model.cutoffKey}`,
    }],
  }));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), fileName);
  return { model, form };
}

export async function sendCardImage({ request, userId, ...cardOptions }) {
  const { model, form } = await createCardImageMessage(cardOptions);
  return sendPreparedCardImage({ request, userId, model, form });
}

export async function sendPreparedCardImage({ request, userId, model, form, nonce = null }) {
  // Reuse the rendered image without changing the original interaction payload.
  let dmForm = form;
  if (nonce) {
    dmForm = new FormData();
    for (const [key, value] of form) dmForm.append(key, value);
    dmForm.set('payload_json', JSON.stringify({
      ...JSON.parse(form.get('payload_json')),
      nonce,
      enforce_nonce: true,
    }));
  }
  const dmChannel = await request('/users/@me/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: userId }),
  });
  const message = await request(`/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    body: dmForm,
  });
  return { model, channelId: dmChannel.id, messageId: message.id };
}
