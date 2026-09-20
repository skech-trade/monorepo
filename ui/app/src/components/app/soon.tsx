"use client";

import { toastManager } from "@/components/ui/toast";

/**
 * Nothing behind these yet.
 *
 * A control that looks live and does nothing is the app telling a small lie,
 * and on a screen about money a small lie is expensive. Every one of them says
 * so when pressed instead. The toast carries one id, so pressing several
 * updates a single notice rather than stacking a pile.
 *
 * The landing has the same thing in `site/soon.tsx`. Two apps, two toasters,
 * so it is duplicated rather than shared.
 */
export function announceSoon(detail: string) {
  toastManager.add({ id: "coming-soon", title: "Not live yet", description: detail });
}
