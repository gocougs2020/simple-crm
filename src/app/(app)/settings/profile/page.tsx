import type { Metadata } from "next";
import { ProfileSettings } from "@/components/settings/profile";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return <ProfileSettings />;
}
