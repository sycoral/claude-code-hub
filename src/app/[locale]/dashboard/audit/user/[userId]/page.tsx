import { getTranslations } from "next-intl/server";
import { UserRealInputsClient } from "./_components/user-real-inputs";

export const dynamic = "force-dynamic";

export default async function AuditUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const t = await getTranslations("dashboard.conversationAudit.userView");
  const userIdNum = Number(userId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("description")}</p>
      </div>
      <UserRealInputsClient userId={Number.isFinite(userIdNum) ? userIdNum : -1} />
    </div>
  );
}
