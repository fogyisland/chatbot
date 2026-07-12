const CJK_RANGE = /[㐀-鿿぀-ゟ゠-ヿ　-〿가-힯]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else ascii++;
  }
  return cjk + Math.ceil(ascii / 4);
}
