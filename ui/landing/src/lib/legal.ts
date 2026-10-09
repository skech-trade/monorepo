/**
 * Who publishes skech, and the few facts the legal pages quote.
 *
 * One file so the privacy policy, the terms and the account deletion page
 * cannot drift apart. Every value in square brackets is a placeholder the
 * owner fills in before launch; the pages render them as written until then.
 */

/** The company or person that publishes skech, as registered. */
export const LEGAL_NAME = "[LEGAL NAME]";

/** Where privacy, deletion and support requests go. */
export const CONTACT_EMAIL = "[support@…]";

/** Where the publisher is established. */
export const COUNTRY = "[COUNTRY]";

/** The law the terms are governed by, and its courts. */
export const GOVERNING_LAW = "[GOVERNING LAW]";

/** Where skech may not be used. Fill in with the owner's list. */
export const EXCLUDED_JURISDICTIONS = ["[EXCLUDED JURISDICTIONS]"];

/** When the current versions of the pages took effect. */
export const EFFECTIVE_DATE = "October 2026";

/**
 * The game's fees, as set on chain today. The stake fee is the admin's to set
 * (2% on Monad testnet since 2026-09-29; a fresh deployment starts at 4%), so
 * check it against the deployed config before launch.
 */
export const STAKE_FEE = "2%";
export const PROFIT_FEE = "10%";

/** What an IOU grows by, at SkechIOU's current rate. */
export const IOU_GROWTH = "about 0.1% a day";

/** The subject line a deletion request is matched on. */
export const DELETE_SUBJECT = "Delete my skech account";

/** How long we take to confirm a deletion. */
export const DELETE_DAYS = 30;

/** A mailto link with the subject filled in, and a body asking for the address. */
export function mailto(subject?: string, body?: string): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${CONTACT_EMAIL}${query ? `?${query}` : ""}`;
}
