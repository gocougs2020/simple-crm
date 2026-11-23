/** What the email signature editor offers. Free of server-only imports so the browser can use it. */

/** Text sizes a signature can use. Normal is Outlook's own 12pt, so it's left unset. */
export const signatureSizes = [
  { label: "Small", value: "13px" },
  { label: "Normal", value: "" },
  { label: "Large", value: "19px" },
  { label: "Larger", value: "24px" },
] as const;

/** The color the picker opens on when the text has none: Outlook's black, which is what email from Outlook is written in. */
export const signatureInk = "#000000";

/** Images in a signature are uploaded at most this wide, so a large photo doesn't swamp the email. */
export const signatureImageWidth = 200;
