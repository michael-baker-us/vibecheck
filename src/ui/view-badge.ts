import type { VerificationBadge } from "../domain/quality-gates";

type BadgeTarget = {
  badge?: VerificationBadge;
};

const EMPTY_BADGE: VerificationBadge = { value: 0, tooltip: "" };

/**
 * Applies a view badge while working around both sides of VS Code's webview badge lifecycle. The
 * extension-host suppresses an initial `undefined` assignment, while the main-thread webview keeps
 * its previous activity when it receives `undefined`. Replacing that activity with zero before
 * every clear removes the visible count, and makes the following `undefined` observable to the host.
 */
export function applyViewBadge(
  view: BadgeTarget,
  badge: VerificationBadge | undefined,
): void {
  if (!badge) view.badge = EMPTY_BADGE;
  view.badge = badge;
}
