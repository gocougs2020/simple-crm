"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { setForwarding } from "@/lib/forwarding/inbound";

/**
 * Settings → Agent → Email forwarding: a teammate turns their own address on,
 * replaces it, or turns it off. Only ever their own; turning it on needs edit
 * access, which the service checks.
 */
export async function changeForwarding(action: "on" | "new" | "off"): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    await setForwarding(user, z.enum(["on", "new", "off"]).parse(action));
    refresh();
  });
}
