import { NEWSLETTER_TOPIC_IDS } from "../config.js";
import { bool, clean, emailError, str, type FieldErrors } from "./common.js";

/** Same rules and messages as the frontend's lib/newsletter.ts (guide p.129–130). */
export type SubscribeInput = { email: string; topics: string[]; consent: boolean; noticeVersion: string; website: string };

const topicList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((t): t is string => typeof t === "string"))].slice(0, 20) : [];

export const isTopic = (t: string) => (NEWSLETTER_TOPIC_IDS as readonly string[]).includes(t);

export function parseSubscribe(body: unknown): SubscribeInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    email: str(b.email).trim().toLowerCase(),
    topics: topicList(b.topics),
    consent: bool(b.consent),
    noticeVersion: str(b.noticeVersion).trim().slice(0, 40),
    website: str(b.website),
  };
}

export function validateSubscribe(input: SubscribeInput): FieldErrors {
  return clean({
    email: emailError(input.email),
    topics:
      input.topics.length === 0 ? "Choose at least one topic." : input.topics.some((t) => !isTopic(t)) ? "Choose topics from the list." : undefined,
    consent: input.consent ? undefined : "Confirm that you agree to receive the legal updates you select.",
  });
}

export function parseTopics(body: unknown): string[] {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return topicList(b.topics);
}

/** Tokens are opaque URL-safe strings (matches the frontend's readToken). */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

export function readToken(value: unknown): string | undefined {
  const token = str(value);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}
