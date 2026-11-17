/**
 * Whose unread a conversation is. Email threads and text conversations share
 * one rule: a conversation's unread state belongs to whoever owns the record
 * it's about (the person, else the organization when no person is linked).
 *
 * - Owned: it shows as unread only for the owner, and only the owner opening
 *   it (or marking it) changes it. Everyone else still sees the conversation.
 * - Not owned (no record, or nobody owns it): it's unread for everyone, and
 *   the first teammate to open it marks it read for everyone.
 *
 * There's one `read` flag per conversation, not one per teammate, so when the
 * record changes hands an unread conversation becomes the new owner's unread.
 * Pure, so the browser and tests use the same rules as the server.
 */

export type ReadState = {
  /** Shows as unread to this teammate. */
  unread: boolean;
  /** This teammate opening it, or marking it read or unread, changes it. */
  canChange: boolean;
  /** Whose unread it is; null when it's everyone's. */
  ownerId: string | null;
};

export function readStateFor(c: { read: boolean; ownerId: string | null }, viewerId: string): ReadState {
  const canChange = c.ownerId === null || c.ownerId === viewerId;
  return { unread: !c.read && canChange, canChange, ownerId: c.ownerId };
}

/** Why a teammate can't change it, for the interface and refusals. */
export function notYoursMessage(ownerName: string | undefined, recordName: string | null) {
  const who = ownerName ?? "Its owner";
  return recordName
    ? `${who} owns ${recordName}, so whether this conversation is read is up to them. It stays as it is for them.`
    : `${who} owns this record, so whether this conversation is read is up to them.`;
}
