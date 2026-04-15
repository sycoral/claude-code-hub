import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { AuditChatViewClient } from "./_components/audit-chat-view";

export const dynamic = "force-dynamic";

export default async function AuditChatPage({
  params,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session || session.user.role !== "admin") {
    return redirect({ href: session ? "/dashboard" : "/login", locale });
  }

  return <AuditChatViewClient />;
}
