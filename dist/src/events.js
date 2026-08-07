/**
 * The shared contract between the proxy and the VS Code extension.
 *
 * This file is the single source of truth for what "an observed MemPalace
 * interaction" looks like. The proxy produces `LensEvent`s; the extension
 * consumes them. Define it once here, import it on both sides, and the two
 * halves can never drift apart — that is the entire reason this project is
 * in TypeScript.
 */
// ---- narrowing helpers ---------------------------------------------------
export function isRequest(msg) {
    return "method" in msg && "id" in msg && msg.id !== undefined;
}
export function isNotification(msg) {
    return "method" in msg && !("id" in msg && msg.id !== undefined);
}
