import { connection } from "next/server";
import { Suspense } from "react";

async function Connection() {
  await connection();
  return null;
}

/**
 * Tells Cache Components this page is intentionally per-request, so its
 * `generateMetadata` may read the database (record names in the tab title).
 */
export function DynamicMarker() {
  return (
    <Suspense>
      <Connection />
    </Suspense>
  );
}
