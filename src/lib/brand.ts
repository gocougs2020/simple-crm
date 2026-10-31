import "server-only";
import type { EmailBrand } from "@/emails/layout";
import { getWorkspace } from "./workspace";

export async function emailBrand(): Promise<EmailBrand> {
  const ws = await getWorkspace();
  return { ...ws.brand, workspaceName: ws.name };
}
