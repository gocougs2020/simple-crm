"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import * as chat from "@/lib/chat/service";
import { sessionActor } from "@/lib/crm/actor";

/** Everyone who can sign in can read and post in the team chat, viewers included. */

export async function postChatMessage(input: { body: string; fileIds?: string[] }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await chat.postChatMessage(sessionActor(await actionUser()), input);
    refresh();
    return { id: row.id };
  });
}

export async function editChatMessage(messageId: string, body: string): Promise<Result> {
  return run(async () => {
    await chat.editChatMessage(sessionActor(await actionUser()), messageId, { body: z.string().parse(body) });
    refresh();
  });
}

export async function deleteChatMessage(messageId: string): Promise<Result> {
  return run(async () => {
    await chat.deleteChatMessage(sessionActor(await actionUser()), messageId);
    refresh();
  });
}

/** Older messages, for scrolling back. */
export async function loadEarlierChat(before: string): Promise<Result<Awaited<ReturnType<typeof chat.listChat>>>> {
  return run(async () => {
    await actionUser();
    return chat.listChat({ before: z.uuid().parse(before) });
  });
}

/** The chat is open and in view: clear the sidebar's unread count. */
export async function markChatRead(): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    await chat.markChatRead(user.id);
    refresh();
  });
}
