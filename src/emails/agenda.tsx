import { Link, Section, Text } from "@react-email/components";
import { EmailButton, EmailLayout, p, small, type EmailBrand } from "./layout";

export type AgendaItem = { id: string; when: string; title: string; record: string | null; url: string };
export type AgendaSection = { title: string; tone?: "error"; items: AgendaItem[]; more: number };

const heading = { margin: "22px 0 6px", fontSize: 13, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" as const, color: "#71717a" };
const row = { margin: 0, padding: "8px 0", borderTop: "1px solid #f4f4f5", fontSize: 14, lineHeight: "20px", color: "#27272a" };

/** A teammate's meetings and tasks for the day or the week. */
export default function AgendaEmail({
  brand,
  kind,
  firstName,
  date,
  sections,
  appUrl,
  settingsUrl,
}: {
  brand: EmailBrand;
  kind: "daily" | "weekly";
  firstName: string;
  date: string;
  sections: AgendaSection[];
  appUrl: string;
  settingsUrl: string;
}) {
  const intro = kind === "weekly" ? `Here's your week, starting ${date}.` : `Here's your day, ${date}.`;
  return (
    <EmailLayout
      brand={brand}
      preview={sections.length ? sections.map((s) => `${s.title}: ${s.items.length + s.more}`).join(" · ") : "Nothing scheduled"}
      footer={
        <Text style={{ margin: "8px 0 0", fontSize: 12, lineHeight: "18px", color: "#71717a" }}>
          You get this because you turned on the {kind} agenda.{" "}
          <Link href={settingsUrl} style={{ color: "#71717a" }}>
            Change your emails
          </Link>
          .
        </Text>
      }
    >
      <Text style={{ ...p, fontSize: 18, fontWeight: 600, color: "#09090b" }}>Good morning, {firstName}</Text>
      <Text style={p}>{intro}</Text>
      {sections.length ? (
        sections.map((s) => (
          <Section key={s.title}>
            <Text style={{ ...heading, color: s.tone === "error" ? "#b91c1c" : heading.color }}>{s.title}</Text>
            {s.items.map((i) => (
              <Text key={i.id} style={row}>
                <span style={{ display: "inline-block", minWidth: 96, color: s.tone === "error" ? "#b91c1c" : "#71717a" }}>{i.when}</span>
                <Link href={i.url} style={{ color: "#09090b", fontWeight: 500, textDecoration: "none" }}>
                  {i.title}
                </Link>
                {i.record ? <span style={{ color: "#71717a" }}> · {i.record}</span> : null}
              </Text>
            ))}
            {s.more ? <Text style={{ ...row, color: "#71717a" }}>and {s.more} more</Text> : null}
          </Section>
        ))
      ) : (
        <Text style={p}>Nothing scheduled and nothing overdue. Enjoy the quiet.</Text>
      )}
      <Section style={{ marginTop: 24 }}>
        <EmailButton href={appUrl} brand={brand}>
          Open your activities
        </EmailButton>
      </Section>
      <Text style={small}>Times are in your workspace&apos;s time zone.</Text>
    </EmailLayout>
  );
}

AgendaEmail.PreviewProps = {
  brand: { workspaceName: "Acme" },
  kind: "daily",
  firstName: "Sam",
  date: "Monday, March 2",
  sections: [
    { title: "Meetings today", items: [{ id: "1", when: "10:00 AM", title: "Quarterly review", record: "Globex", url: "https://example.com" }], more: 0 },
    { title: "Overdue", tone: "error", items: [{ id: "2", when: "Friday", title: "Send proposal", record: "Initech", url: "https://example.com" }], more: 0 },
    { title: "Due today", items: [{ id: "3", when: "Any time", title: "Call Jane back", record: "Jane Doe", url: "https://example.com" }], more: 0 },
  ],
  appUrl: "https://example.com/activities",
  settingsUrl: "https://example.com/settings/notifications",
};
