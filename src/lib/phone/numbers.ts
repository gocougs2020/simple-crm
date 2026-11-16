/**
 * Phone numbers as people type them ("(303) 555-0123", "303.555.0123 x4",
 * "+44 20 7946 0958") and as Twilio wants them (E.164: +13035550123). Pure, so
 * the browser and tests use the same rules as the server.
 */

/** The digits of a number, without an extension. */
export function digitsOf(raw: string | null | undefined) {
  if (!raw) return "";
  return raw.replace(/\s*(?:x|ext\.?|extension|#)\s*\d+\s*$/i, "").replace(/\D/g, "");
}

/**
 * E.164 for a typed number, or null when it can't be one. A leading + (or 00)
 * means the country code is there; otherwise `countryCode` is added, unless
 * the number already starts with it and is long enough to include it
 * (11 digits starting with 1, for North America).
 */
export function toE164(raw: string | null | undefined, countryCode = "1"): string | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  let digits = digitsOf(trimmed);
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const cc = countryCode.replace(/\D/g, "") || "1";
  if (cc === "1") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith(cc) && digits.length > 9) return `+${digits}`;
  const full = `${cc}${digits}`;
  return full.length >= 8 && full.length <= 15 ? `+${full}` : null;
}

/**
 * What two numbers are compared on: the last 10 digits. It ignores how the
 * country code and punctuation were typed, which is how calls and texts find
 * the person they're from (the SQL in src/lib/phone/match.ts does the same).
 */
export function matchKey(raw: string | null | undefined) {
  return digitsOf(raw).slice(-10);
}

/** For display: North American numbers as (303) 555-0123, others as E.164 with spaces. */
export function formatPhone(raw: string | null | undefined) {
  if (!raw) return "";
  const e164 = raw.startsWith("+") ? `+${digitsOf(raw)}` : raw;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return raw;
}

/** Number of SMS segments a text takes, which is what carriers bill. GSM-7 text fits 160 (153 when split); anything else 70 (67). */
export function smsSegments(text: string) {
  if (!text) return 0;
  // The GSM 03.38 basic set, plus the extension table (which costs two characters each).
  const basic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const extended = "^{}\\[~]|€\f";
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (basic.includes(ch)) units += 1;
    else if (extended.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  const length = [...text].length;
  return length <= 70 ? 1 : Math.ceil(length / 67);
}
