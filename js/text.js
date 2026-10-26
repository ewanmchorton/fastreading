// Splitting text into words, finding the focus letter and timing each word.

const LONE_PUNCT = /^[—–\-…,.;:!?»”)\]]+$/;

// Returns { words: string[], paraStart: number[] }: paraStart[p] is the index of paragraph p's first word.
export function tokenize(paras) {
  const words = [];
  const paraStart = [];
  for (const para of paras) {
    paraStart.push(words.length);
    const first = words.length;
    for (const tok of para.split(' ')) {
      if (!tok) continue;
      // A dash or punctuation standing alone would flash as an empty word: glue it to the previous one.
      if (LONE_PUNCT.test(tok) && words.length > first) words[words.length - 1] += ' ' + tok;
      else words.push(tok);
    }
    if (words.length === first) words.push('·'); // keep every paragraph addressable
  }
  return { words, paraStart };
}

// Index of the letter the eye should lock onto (Optimal Recognition Point),
// skipping leading quotes and brackets.
export function focusIndex(word) {
  const lead = word.match(/^[^\p{L}\p{N}]*/u)[0].length;
  const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '');
  const n = core.length;
  if (n === 0) return 0;
  const orp = n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4;
  return lead + orp;
}

// How long to show a word, as a multiple of the base interval.
export function wordWeight(word, endsParagraph, punctuationPauses) {
  let w = 1;
  if (word.length > 8) w += 0.2 + Math.min(word.length - 8, 8) * 0.04;
  if (/\d/.test(word)) w += 0.3;
  if (!punctuationPauses) return w;
  if (endsParagraph) return w + 1.5;
  if (/[.!?…]["»”)\]]*$/.test(word)) return w + 1.2;
  if (/[,;:—–]["»”)\]]*$/.test(word) || / [—–]$/.test(word)) return w + 0.5;
  return w;
}

export function isSentenceEnd(word) {
  return /[.!?…]["»”)\]]*$/.test(word);
}
