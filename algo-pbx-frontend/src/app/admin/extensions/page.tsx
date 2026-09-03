import { redirect } from "next/navigation";

// Merged into /admin/dinstar's "Extensions" tab (see that page + its
// telephony/extensions-tab.tsx). Kept as a redirect so existing bookmarks
// and links don't 404 — same pattern as admin/layout.tsx's role-based
// redirect.
export default function ExtensionsPage() {
  redirect("/admin/dinstar");
}
