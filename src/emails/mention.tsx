import { Link, Section, Text } from "@react-email/components";
import { EmailButton, EmailLayout, p, small, type EmailBrand } from "./layout";

/**
 * "Sam mentioned you": sent when a teammate writes @ and someone's name in a
 * note, a reply or the team chat. Quotes what they wrote and links straight
 * to it, and to the record it's on.
 */
export default function MentionEmail({
  brand,
  firstName,
  title,
  quote,
  url,
  action,
  record,
  settingsUrl,
}: {
  brand: EmailBrand;
  firstName: string;
  /** "Sam Lee mentioned you in a note on Acme". */
  title: string;
  /** What they wrote, as plain text. */
  quote: string;
  /** The note or message itself. */
  url: string;
  /** The button: "Open the note", "Open the message". */
  action: string;
  /** The record the note is on, when there is one. */
  record?: { name: string; kind: string; url: string } | null;
  settingsUrl: string;
}) {
  return (
    <EmailLayout
      brand={brand}
      preview={quote.slice(0, 140)}
      footer={
        <Text style={{ margin: "8px 0 0", fontSize: 12, lineHeight: "18px", color: "#71717a" }}>
          You get this because someone mentioned you.{" "}
          <Link href={settingsUrl} style={{ color: "#71717a" }}>
            Change your emails
          </Link>
          .
        </Text>
      }
    >
      <Text style={{ ...p, fontSize: 18, fontWeight: 600, color: "#09090b" }}>Hi {firstName},</Text>
      <Text style={p}>{title}.</Text>
      <Section style={{ margin: "0 0 18px", padding: "12px 16px", borderLeft: "3px solid #e4e4e7", backgroundColor: "#fafafa", borderRadius: 6 }}>
        <Text style={{ margin: 0, fontSize: 14, lineHeight: "22px", color: "#27272a", whiteSpace: "pre-wrap" }}>{quote}</Text>
      </Section>
      <Section>
        <EmailButton href={url} brand={brand}>
          {action}
        </EmailButton>
      </Section>
      {record ? (
        <Text style={small}>
          It&apos;s on the {record.kind}{" "}
          <Link href={record.url} style={{ color: "#52525b" }}>
            {record.name}
          </Link>
          .
        </Text>
      ) : null}
    </EmailLayout>
  );
}

MentionEmail.PreviewProps = {
  brand: { workspaceName: "Acme" },
  firstName: "Jo",
  title: "Sam Lee mentioned you in a note on Globex",
  quote: "@Jo Park can you send them the updated price sheet before Friday?",
  url: "https://example.com/clients/1#a-2",
  action: "Open the note",
  record: { name: "Globex", kind: "client", url: "https://example.com/clients/1" },
  settingsUrl: "https://example.com/settings/notifications",
};
