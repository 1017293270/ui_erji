import { type Feishu, MalformedError, text } from "./client";

/**
 * The company's bot writing to one person: a message card in their chat with the app. Needs the
 * bot ability and 「以应用的身份发消息」 (im:message:send_as_bot); the person must be in the app's
 * availability scope.
 */

/** A message card (Feishu card JSON 1.0). */
export type Card = Record<string, unknown>;

/** Sends `card` to the person with this open_id and returns the message id. */
export async function sendCard(feishu: Feishu, openId: string, card: Card): Promise<string> {
  const reply = await feishu.asApp((token) =>
    feishu.send(feishu.url(["im", "v1", "messages"], { receive_id_type: "open_id" }), {
      method: "POST",
      token,
      json: { receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) },
    }),
  );
  const id = text(reply.data?.message_id);
  if (!id) throw new MalformedError("消息 ID");
  return id;
}

/** Replaces a card the bot sent. Only cards with `update_multi` can be changed. */
export async function updateCard(feishu: Feishu, messageId: string, card: Card): Promise<void> {
  await feishu.asApp((token) =>
    feishu.send(feishu.url(["im", "v1", "messages", messageId]), { method: "PATCH", token, json: { content: JSON.stringify(card) } }),
  );
}
