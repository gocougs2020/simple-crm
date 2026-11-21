import type { Metadata } from "next";
import { Suspense } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { listChat } from "@/lib/chat/service";

export const metadata: Metadata = { title: "Team chat" };

export default function ChatPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Chat />
    </Suspense>
  );
}

async function Chat() {
  const { messages, hasMore, version } = await listChat();
  return <ChatView latest={messages} hasMore={hasMore} version={version} />;
}
