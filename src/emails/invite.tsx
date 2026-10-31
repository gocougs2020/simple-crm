import { Text } from "@react-email/components";
import { EmailButton, EmailLayout, p, small, type EmailBrand } from "./layout";

export default function InviteEmail({ brand, inviter, url }: { brand: EmailBrand; inviter: string; url: string }) {
  return (
    <EmailLayout brand={brand} preview={`${inviter} invited you to ${brand.workspaceName}'s CRM`}>
      <Text style={{ ...p, fontSize: 18, fontWeight: 600, color: "#09090b" }}>Join {brand.workspaceName} in the CRM</Text>
      <Text style={p}>{inviter} invited you to the team. Set a password to get started.</Text>
      <EmailButton href={url} brand={brand}>
        Accept invite
      </EmailButton>
      <Text style={small}>This link works once and expires in 7 days. If you weren&apos;t expecting it, you can ignore this email.</Text>
    </EmailLayout>
  );
}

InviteEmail.PreviewProps = { brand: { workspaceName: "Acme" }, inviter: "Jordan Lee", url: "https://example.com/invite/token" };
