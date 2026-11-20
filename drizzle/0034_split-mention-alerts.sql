-- "Mentions and replies" became three alerts: mentioned in a note, replies to my notes, and mentioned in team chat.
-- A device that had it keeps all three. The new alerts (every team chat message, activity and stage changes on
-- records I own) start off on existing devices; new devices get all but every team chat message.
UPDATE "push_subscriptions"
SET "alerts" = ("alerts" - 'mention') || '["note_mention", "note_reply", "chat_mention"]'::jsonb
WHERE "alerts" ? 'mention';
