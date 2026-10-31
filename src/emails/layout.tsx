import { Body, Container, Head, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";
import type { BrandKit } from "@/db/schema";

/** What every email is wrapped in. Colors and logo come from the workspace's brand kit; with no kit it's plain and neutral. */
export type EmailBrand = BrandKit & { workspaceName: string };

export const emailFont = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
export const accentOf = (b: EmailBrand) => (b.accentColor && /^#[0-9a-f]{6}$/i.test(b.accentColor) ? b.accentColor : "#18181b");

export function EmailLayout({ brand, preview, children, footer }: { brand: EmailBrand; preview: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ margin: 0, backgroundColor: "#f4f4f5", padding: "32px 12px", fontFamily: emailFont, color: "#27272a" }}>
        <Container style={{ width: "100%", maxWidth: 560, backgroundColor: "#ffffff", borderRadius: 12, border: "1px solid #e4e4e7" }}>
          <Section style={{ padding: "24px 32px 0" }}>
            {brand.logoUrl ? (
              <Img src={brand.logoUrl} alt={brand.workspaceName} height="28" style={{ height: 28, width: "auto" }} />
            ) : (
              <Text style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#09090b" }}>{brand.workspaceName}</Text>
            )}
          </Section>
          <Section style={{ padding: "20px 32px 28px" }}>{children}</Section>
          <Hr style={{ margin: 0, borderColor: "#e4e4e7" }} />
          <Section style={{ padding: "16px 32px 20px" }}>
            <Text style={{ margin: 0, fontSize: 12, lineHeight: "18px", color: "#71717a" }}>
              {brand.workspaceName}
              {brand.website ? (
                <>
                  {" · "}
                  <Link href={brand.website} style={{ color: "#71717a" }}>
                    {brand.website.replace(/^https?:\/\//, "")}
                  </Link>
                </>
              ) : null}
              {brand.postalAddress ? (
                <>
                  <br />
                  {brand.postalAddress}
                </>
              ) : null}
            </Text>
            {footer}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailButton({ href, brand, children }: { href: string; brand: EmailBrand; children: ReactNode }) {
  return (
    <Link
      href={href}
      style={{ display: "inline-block", backgroundColor: accentOf(brand), color: "#ffffff", borderRadius: 6, padding: "10px 18px", fontSize: 14, fontWeight: 600, textDecoration: "none" }}
    >
      {children}
    </Link>
  );
}

export const p = { margin: "0 0 14px", fontSize: 15, lineHeight: "24px", color: "#27272a" } as const;
export const small = { margin: "16px 0 0", fontSize: 13, lineHeight: "20px", color: "#71717a" } as const;
