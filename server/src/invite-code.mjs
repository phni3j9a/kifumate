const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateInviteCode() {
  // 32種類なので各乱数バイトの下位5ビットを使っても偏りは生じない（16文字で80ビット）。
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => ALPHABET[byte & 31])
    .join('').match(/.{4}/g).join('-');
}

export function normalizeInviteCode(value) {
  const code = value.normalize('NFKC').toUpperCase().replace(/[\s\p{Dash_Punctuation}]/gu, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) ? code : null;
}
