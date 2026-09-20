/**
 * Lighter, as the venue actually is.
 *
 * Moved to `@skech/core` when the trader started signing the same rounds the
 * browser quotes: the size floors, the margin levels and the liquidation
 * formula have to be one set of numbers, or the page promises a position the
 * venue will not take. This re-exports so every `@/lib/venue` import in the
 * app keeps working.
 */

export * from "@skech/core/venue";
