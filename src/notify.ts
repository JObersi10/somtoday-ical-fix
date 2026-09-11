// Push notifications via ntfy.sh — a free, account-less pub/sub push service.
// You pick a topic name (treat it like a secret — anyone who knows it can
// publish to or read it), install the ntfy app on your phone, and subscribe
// to that same topic. No API key, no signup.
//
// Notifications are always best-effort: a failed push must never take down
// the actual sync it's reporting on.

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export async function notify(
  topic: string | undefined,
  title: string,
  message: string,
  opts: { priority?: Priority; tags?: string[] } = {}
): Promise<void> {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        ...(opts.priority ? { Priority: opts.priority } : {}),
        ...(opts.tags?.length ? { Tags: opts.tags.join(",") } : {}),
      },
      body: message,
    });
  } catch {
    // best-effort, swallow
  }
}
