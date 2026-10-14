/**
 * Rough token count for budgeting, from DeepSeek's own rule of thumb
 * (api-docs.deepseek.com/quick_start/token_usage, checked 2026-10-13):
 * 1 Chinese character ≈ 0.6 token, 1 English character ≈ 0.3 token.
 * Real counts come back in the usage of each call.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isWide(code)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

function isWide(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x3400 && code <= 0x9fff) || // CJK ideographs + ext A
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) || // full-width forms
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}
