/**
 * Token estimation using tiktoken (cl100k_base).
 *
 * cl100k_base is not Claude's actual tokenizer, but it's a much closer
 * approximation than the naive ~4 chars/token heuristic. Good enough to
 * compare relative costs ("this search cost 10x that one"), which is what
 * the visualization needs.
 */

import { encodingForModel } from "js-tiktoken";

const enc = encodingForModel("gpt-4o");

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return enc.encode(text).length;
}
