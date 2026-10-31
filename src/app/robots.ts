import type { MetadataRoute } from "next";

/** A private CRM: nothing to crawl. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
