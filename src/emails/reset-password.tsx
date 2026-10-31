import { Text } from "@react-email/components";
import { EmailButton, EmailLayout, p, small, type EmailBrand } from "./layout";

export default function ResetPasswordEmail({ brand, url }: { brand: EmailBrand; url: string }) {
  return (
    <EmailLayout brand={brand} preview="Reset your CRM password">
      <Text style={{ ...p, fontSize: 18, fontWeight: 600, color: "#09090b" }}>Reset your password</Text>
      <Text style={p}>Someone asked to reset the password for your {brand.workspaceName} CRM account. If it was you, choose a new one:</Text>
      <EmailButton href={url} brand={brand}>
        Choose a new password
      </EmailButton>
      <Text style={small}>This link works once and expires in 1 hour. If you didn&apos;t ask for it, ignore this email: your password stays the same.</Text>
    </EmailLayout>
  );
}

ResetPasswordEmail.PreviewProps = { brand: { workspaceName: "Acme" }, url: "https://example.com/reset/token" };
