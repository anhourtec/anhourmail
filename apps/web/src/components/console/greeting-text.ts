// SPDX-License-Identifier: AGPL-3.0-only
/** "Good morning" before noon, "Good afternoon" until 6 pm, then "Good evening" (the person's local time). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/** First name for the greeting: the display name's first word, else the email's local part. */
export function firstName(name: string | null | undefined, email: string): string {
  const fromName = (name ?? "").trim().split(/\s+/)[0];
  return fromName && fromName !== "" ? fromName : (email.split("@")[0] ?? email);
}
