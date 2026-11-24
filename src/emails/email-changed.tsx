import { Text } from "@react-email/components";
import { EmailLayout, p, small, type EmailBrand } from "./layout";

/** Goes to a teammate's old address when an owner changes the one they sign in with. */
export default function EmailChangedEmail({ brand, changedBy, newEmail }: { brand: EmailBrand; changedBy: string; newEmail: string }) {
  return (
    <EmailLayout brand={brand} preview={`You now sign in to ${brand.workspaceName}'s CRM with ${newEmail}`}>
      <Text style={{ ...p, fontSize: 18, fontWeight: 600, color: "#09090b" }}>Your sign-in email changed</Text>
      <Text style={p}>
        {changedBy} changed the email you sign in to {brand.workspaceName}&apos;s CRM with to {newEmail}. Your password and everything else stay the same.
      </Text>
      <Text style={small}>If you didn&apos;t expect this, contact {changedBy} or another owner.</Text>
    </EmailLayout>
  );
}

EmailChangedEmail.PreviewProps = { brand: { workspaceName: "Acme" }, changedBy: "Jordan Lee", newEmail: "sam@newco.com" };
