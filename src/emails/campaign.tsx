import { Link, Text } from "@react-email/components";
import { emailHtml } from "./direct";
import { accentOf, EmailLayout, type EmailBrand } from "./layout";

/**
 * A campaign email: the brand kit's layout around the body. Merge tags stay
 * as {{tags}} in the rendered HTML and are filled per recipient at send time,
 * along with {{unsubscribe_url}}.
 */
export default function CampaignEmail({ brand, body, preview }: { brand: EmailBrand; body: string; preview: string }) {
  return (
    <EmailLayout
      brand={brand}
      preview={preview}
      footer={
        <Text style={{ margin: "10px 0 0", fontSize: 12, lineHeight: "18px", color: "#71717a" }}>
          You&apos;re receiving this because you&apos;ve been in touch with {brand.workspaceName}.{" "}
          <Link href="{{unsubscribe_url}}" style={{ color: "#71717a", textDecoration: "underline" }}>
            Unsubscribe
          </Link>
        </Text>
      }
    >
      <div style={{ fontSize: 15, lineHeight: "24px", color: "#27272a" }} dangerouslySetInnerHTML={{ __html: emailHtml(body, accentOf(brand)) }} />
    </EmailLayout>
  );
}

CampaignEmail.PreviewProps = { brand: { workspaceName: "Acme", postalAddress: "123 Main St, Boise, ID 83702" }, preview: "What's new this fall", body: "<p>Hi {{first_name|there}},</p><p>Here's what's new.</p>" };
