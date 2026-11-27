import { PEOPLE } from '../lib/streak-engine.ts';
import { createCardImageMessage, sendPreparedCardImage } from './discord-card-message.mjs';

export function resolvePeekTarget(userId, targetId, subscriptions, spectators, now = new Date()) {
  if (typeof targetId !== 'string' || !Object.hasOwn(PEOPLE, targetId)) {
    throw new Error('Please choose one card.');
  }
  const owner = Object.entries(subscriptions.byPerson).find(([, entry]) => entry.userId === userId)?.[0];
  if (owner === targetId) {
    throw new Error('Choose one of the other cards. Use /status for your own.');
  }
  if (!owner && spectators.target(userId, subscriptions, now) !== targetId) {
    throw new Error('You can only peek at the card you are actively spectating. Use /spectate with the current access code first.');
  }
  return targetId;
}

export async function sendPeekCardReply({
  request,
  interaction,
  userId,
  personId,
  loadTrackerState,
  loadBackground = () => null,
  getNow = () => new Date(),
}) {
  // Acknowledge before rendering the PNG; preserve private replies outside bot DMs.
  await request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 5,
      data: interaction.context !== 1 ? { flags: 64 } : {},
    }),
  });
  const responsePath = `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  let card;
  let message;
  try {
    card = await createCardImageMessage({
      personId,
      trackerState: loadTrackerState(),
      now: getNow(),
      backgroundDataUri: loadBackground(personId),
    });
    message = await request(responsePath, { method: 'PATCH', body: card.form });
  } catch (error) {
    await request(responsePath, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Could not send the card image. Please try /peek again.',
        attachments: [],
        allowed_mentions: { parse: [] },
      }),
    });
    throw error;
  }

  // Replies in the bot's own DMs already persist. Other contexts also get a
  // regular DM, addressed to the person invoking /peek, not the card owner.
  if (interaction.context !== 1) {
    try {
      await sendPreparedCardImage({
        request,
        userId,
        ...card,
        nonce: interaction.id,
      });
    } catch (error) {
      try {
        await request(responsePath, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `${card.model.name} — Day ${card.model.day} Ongoing\n\nCould not send a copy to your DMs with the bot. Please try /peek again.`,
            // Omitting attachments preserves the successfully uploaded card.
            allowed_mentions: { parse: [] },
          }),
        });
      } catch {
        // Preserve the original DM failure for the bot's error log.
      }
      throw error;
    }
  }
  return { model: card.model, messageId: message.id };
}
