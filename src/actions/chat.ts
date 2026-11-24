"use server";

import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import * as chat from "@/lib/chat/service";
import { sessionActor } from "@/lib/crm/actor";
import { badgesFor } from "@/lib/sidebar-counts";

/**
 * Everyone who can sign in can read and post in the team chat, viewers included.
 * These don't refresh the page: the chat fetches what changed itself
 * (`loadChatChanges`), and other open pages see it through /api/live.
 */

export async function postChatMessage(input: { body: string; fileIds?: string[]; replyToId?: string | null }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await chat.postChatMessage(sessionActor(await actionUser()), input);
    return { id: row.id };
  });
}

export async function editChatMessage(messageId: string, body: string): Promise<Result> {
  return run(async () => {
    await chat.editChatMessage(sessionActor(await actionUser()), messageId, { body: z.string().parse(body) });
  });
}

export async function deleteChatMessage(messageId: string): Promise<Result> {
  return run(async () => {
    await chat.deleteChatMessage(sessionActor(await actionUser()), messageId);
  });
}

/** Older messages, for scrolling back. */
export async function loadEarlierChat(before: string): Promise<Result<Awaited<ReturnType<typeof chat.listChat>>>> {
  return run(async () => {
    await actionUser();
    return chat.listChat({ before: z.uuid().parse(before) });
  });
}

/** Messages posted, edited or deleted since the chat's version `since`, for the open chat to follow along. */
export async function loadChatChanges(since: string): Promise<Result<Awaited<ReturnType<typeof chat.chatChangesSince>>>> {
  return run(async () => {
    await actionUser();
    return chat.chatChangesSince(z.string().parse(since));
  });
}

/** The chat is open and in view: clear the sidebar's unread count. Returns the badges, so the sidebar updates without re-rendering the page. */
export async function markChatRead(): Promise<Result<Awaited<ReturnType<typeof badgesFor>>>> {
  return run(async () => {
    const user = await actionUser();
    const readAt = await chat.markChatRead(user.id);
    return badgesFor({ ...user, chatReadAt: readAt });
  });
}
