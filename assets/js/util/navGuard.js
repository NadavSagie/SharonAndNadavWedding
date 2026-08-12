/**
 * Suppresses exactly one deep-link reopen.
 *
 * Bug this exists to fix: opening a photo pushes one history entry; swiping
 * to a different photo REPLACES it (see lightbox.js). Closing calls
 * history.back() to unwind that entry. If the guest swiped before closing,
 * back() lands on a hash that still has a `:photo` param (the ORIGINAL
 * deep-linked photo) — the router's hashchange handler re-renders that route,
 * and the view's mounted() hook sees a photo param and dutifully reopens a
 * lightbox for it. Net effect: closing after swiping doesn't close anything,
 * it silently reopens a stale photo instead.
 *
 * The fix has to live outside both lightbox.js and the views: lightbox.js
 * knows exactly when its own history.back() is about to fire a spurious
 * hashchange, and the views know when they're about to act on one — this
 * module is just the (very short-lived) handshake between them.
 */

let suppressed = false;
let expiry = null;

export function suppressNextDeepLink() {
  suppressed = true;
  // Self-expiring safety net: if back() lands on some other route entirely
  // (neither photosView nor personView consumes the flag), it must never
  // survive to incorrectly swallow a later, unrelated deep link.
  clearTimeout(expiry);
  expiry = setTimeout(() => { suppressed = false; }, 1000);
}

export function consumeDeepLinkSuppression() {
  const value = suppressed;
  suppressed = false;
  clearTimeout(expiry);
  return value;
}
