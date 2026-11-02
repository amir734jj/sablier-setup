import { DateTime } from "luxon";

export function parseTime(value) {
  if (typeof value !== "string") throw new Error("Invalid Docker lifecycle timestamp");

  const timestamp = DateTime.fromISO(value, { zone: "utc" });

  if (!timestamp.isValid) throw new Error("Invalid Docker lifecycle timestamp");

  return timestamp;
}

export function formatTime(value) {
  return parseTime(value).toFormat("yyyy-MM-dd HH:mm:ss.SSS 'UTC'");
}

export function relativeTime(value, checkedAt) {
  if (!value) return "Not available";

  const timestamp = parseTime(value);
  const base = parseTime(checkedAt);

  if (timestamp >= base) return "0 seconds ago";

  return timestamp.toRelative({
    base,
    unit: ["days", "hours", "minutes", "seconds"],
    locale: "en",
    numeric: "always",
    round: true,
  });
}

export function keyedRows(items, fields) {
  const counts = new Map();

  return items.map(value => {
    const key = JSON.stringify(fields.map(field => value[field]));
    const occurrence = counts.get(key) ?? 0;

    counts.set(key, occurrence + 1);

    return { key: `${key}:${occurrence}`, value };
  });
}

export function diagnosticsMessage(data) {
  const summary = data.events.length
    ? "Events checked"
    : "No recognized events in the available log window; checked";
  const messages = [
    `${summary} at ${data.checked_at}.`,
    "Summaries describe recent history, not current failures.",
  ];

  if (data.limited) {
    messages.push("History limit reached.");
  }

  if (data.ignored_records) {
    messages.push(`${data.ignored_records} unrecognized or unrelated records omitted.`);
  }

  return messages.join(" ");
}
