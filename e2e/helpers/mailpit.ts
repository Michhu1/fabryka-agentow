/**
 * Reads the mails the app sent from Mailpit (`pnpm infra:up`, http://localhost:8025): the E2E test
 * follows the links in them like a person clicking in their inbox.
 */
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

type MessageSummary = { ID: string };
type SearchResult = { messages: MessageSummary[] | null };
type Message = { Text: string };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** Deletes every message, so a run only sees its own mails. */
export async function clearMailbox(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  } catch (error) {
    throw new Error(
      `Mailpit is not reachable at ${MAILPIT_URL} (${String(error)}) - start it with: pnpm infra:up`,
    );
  }
  if (!response.ok) throw new Error(`Mailpit could not delete the messages (${response.status})`);
}

/** Links in a plain-text mail whose path starts with `pathPrefix`. */
function linksIn(text: string, pathPrefix: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"]+/g) ?? []).filter((link) =>
    new URL(link).pathname.startsWith(pathPrefix),
  );
}

/**
 * The link with path `pathPrefix` (e.g. `/reset-password`) from the newest mail to `email` that has one.
 * The server sends mail without waiting for it, so this polls until the mail arrives.
 */
export async function latestLinkFor(email: string, pathPrefix: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:${email}`);
  for (;;) {
    // Newest first.
    const { messages } = await getJson<SearchResult>(`/api/v1/search?query=${query}`);
    for (const summary of messages ?? []) {
      const message = await getJson<Message>(`/api/v1/message/${summary.ID}`);
      const [link] = linksIn(message.Text, pathPrefix);
      if (link) return link;
    }
    if (Date.now() > deadline)
      throw new Error(`No mail to ${email} with a ${pathPrefix} link within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
