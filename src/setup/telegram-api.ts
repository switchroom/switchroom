/**
 * Telegram Bot API helpers for the setup wizard.
 */

/**
 * Telegram's Bot API requires the token as a URL path segment. If the
 * underlying fetch error ever includes the request URL — or if a caller
 * ever stringifies a Response object that preserves `.url` — the token
 * would leak to whatever log sink consumes the error. This helper scrubs
 * the literal token from a string before it escapes to the caller.
 */
function redactToken(message: string, token: string): string {
  if (!token || token.length < 8) return message;
  return message.split(token).join("<redacted-bot-token>");
}

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface DmPairResult {
  userId: number;
  username: string;
  chatId: number;
}

export interface GroupJoinResult {
  chatId: number;
  title: string;
}

/**
 * Validate a bot token by calling getMe.
 * Returns bot info on success, throws on failure.
 */
export async function validateBotToken(token: string): Promise<BotInfo> {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      redactToken(
        `Network error validating bot token: ${(err as Error).message}`,
        token,
      ),
    );
  }

  const data = (await response.json()) as {
    ok: boolean;
    result?: BotInfo;
    description?: string;
  };

  if (!data.ok || !data.result) {
    throw new Error(
      `Invalid bot token: ${data.description ?? "Unknown error"}`,
    );
  }

  return data.result;
}

/**
 * Assert that a bot's username contains the expected agent slug.
 *
 * Telegram bot usernames follow no single naming convention — Switchroom
 * agents use both `@<slug>_meken_bot` and `@meken_<slug>_bot` depending on
 * BotFather history. The minimal convention we enforce is that the slug
 * appears somewhere in the username (case-insensitive).
 *
 * Throws with a human-readable message when the username does not contain
 * the slug, so the caller can surface it as a loud error.
 *
 * @param username - The bot username returned by getMe (without leading @).
 * @param agentSlug - The agent name / slug (e.g. "finn", "gymbro").
 */
export function assertBotUsernameMatchesAgent(
  username: string,
  agentSlug: string,
): void {
  const lowerUsername = username.toLowerCase();
  const lowerSlug = agentSlug.toLowerCase();
  if (!lowerUsername.includes(lowerSlug)) {
    throw new Error(
      `agent "${agentSlug}" bot_token resolves to @${username} — expected username to contain "${agentSlug}". ` +
        `Check switchroom.yaml or the vault entry (bot_token key may point to the wrong bot).`,
    );
  }
}

/**
 * Validate a bot token by calling getMe, then assert the returned username
 * matches the expected agent slug. Throws on network error, invalid token,
 * or username mismatch.
 *
 * This is the combined validation that should be called at scaffold/reconcile
 * time so mismatched tokens (e.g. clerk's token written to finn's .env) are
 * caught immediately with a clear error.
 */
export async function validateBotTokenMatchesAgent(
  token: string,
  agentSlug: string,
): Promise<BotInfo> {
  const botInfo = await validateBotToken(token);
  assertBotUsernameMatchesAgent(botInfo.username, agentSlug);
  return botInfo;
}

/**
 * Poll getUpdates looking for a /start message from a private chat.
 * Returns the sender's info once found.
 */
export async function pollForDmStart(
  token: string,
  timeoutMs: number = 120_000,
): Promise<DmPairResult> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=2&allowed_updates=["message"]`;
    let data: any;
    try {
      const response = await fetch(url);
      data = await response.json();
    } catch {
      await sleep(2000);
      continue;
    }

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (
          msg &&
          msg.chat?.type === "private" &&
          msg.text === "/start"
        ) {
          return {
            userId: msg.from.id,
            username:
              msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
            chatId: msg.chat.id,
          };
        }
      }
    }

    await sleep(2000);
  }

  throw new Error("Timed out waiting for /start DM");
}

/**
 * Poll getUpdates looking for a my_chat_member event in a supergroup with is_forum.
 * This fires when the bot is added to a forum group.
 */
export async function pollForGroupJoin(
  token: string,
  timeoutMs: number = 120_000,
): Promise<GroupJoinResult> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=2&allowed_updates=["my_chat_member"]`;
    let data: any;
    try {
      const response = await fetch(url);
      data = await response.json();
    } catch {
      await sleep(2000);
      continue;
    }

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        offset = update.update_id + 1;

        const member = update.my_chat_member;
        if (
          member &&
          member.chat?.type === "supergroup" &&
          member.chat?.is_forum === true
        ) {
          return {
            chatId: member.chat.id,
            title: member.chat.title ?? "Unknown group",
          };
        }
      }
    }

    await sleep(2000);
  }

  throw new Error("Timed out waiting for bot to be added to a forum group");
}

/**
 * Validate that the bot is an admin in the given chat.
 */
export async function validateGroupAdmin(
  token: string,
  chatId: string,
): Promise<boolean> {
  // First get bot info
  const botInfo = await validateBotToken(token);

  const url = `https://api.telegram.org/bot${token}/getChatMember`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: botInfo.id,
    }),
  });

  const data = (await response.json()) as {
    ok: boolean;
    result?: { status: string };
    description?: string;
  };

  if (!data.ok || !data.result) {
    throw new Error(
      `Failed to check admin status: ${data.description ?? "Unknown error"}`,
    );
  }

  const adminStatuses = ["administrator", "creator"];
  return adminStatuses.includes(data.result.status);
}

/**
 * Validate that a chat is a forum (has topics enabled).
 */
export async function validateGroupForum(
  token: string,
  chatId: string,
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/getChat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  });

  const data = (await response.json()) as {
    ok: boolean;
    result?: { type: string; is_forum?: boolean };
    description?: string;
  };

  if (!data.ok || !data.result) {
    throw new Error(
      `Failed to get chat info: ${data.description ?? "Unknown error"}`,
    );
  }

  return data.result.is_forum === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
