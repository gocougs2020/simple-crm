import { PageHeader } from "@/components/shell/app-shell";
import { SettingsNav } from "@/components/settings/nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 md:grid-cols-[180px_minmax(0,1fr)] lg:px-6">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
