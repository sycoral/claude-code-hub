import { getTranslations } from "next-intl/server";
import { AuditListClient } from "./_components/audit-list";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const t = await getTranslations("dashboard.conversationAudit");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("description")}</p>
      </div>
      <AuditListClient />
    </div>
  );
}
