import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { fetchClientVersionStats } from "@/actions/client-versions";
import { fetchSystemSettings } from "@/actions/system-config";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { SettingsSection } from "../_components/ui/settings-ui";
import { ClientVersionStatsTable } from "./_components/client-version-stats-table";
import { ClientVersionToggle } from "./_components/client-version-toggle";
import {
  ClientVersionsSettingsSkeleton,
  ClientVersionsTableSkeleton,
} from "./_components/client-versions-skeleton";

export default async function ClientVersionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // Await params to ensure locale is available in the async context
  const { locale } = await params;

  const t = await getTranslations({ locale, namespace: "settings" });
  const session = await getSession();

  if (!session || session.user.role !== "admin") {
    return redirect({ href: "/login", locale });
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("clientVersions.title")}
        description={t("clientVersions.description")}
        icon="smartphone"
      />
      {/* Settings Toggle Section */}
      <SettingsSection
        title={t("clientVersions.section.settings.title")}
        description={t("clientVersions.section.settings.description")}
        icon="smartphone"
        iconColor="text-[#E25706]"
      >
        <Suspense fallback={<ClientVersionsSettingsSkeleton />}>
          <ClientVersionsSettingsContent />
        </Suspense>
      </SettingsSection>

      {/* Version Distribution Section */}
      <SettingsSection
        title={t("clientVersions.section.distribution.title")}
        description={t("clientVersions.section.distribution.description")}
        icon="smartphone"
        iconColor="text-[#E25706]"
      >
        <Suspense fallback={<ClientVersionsTableSkeleton />}>
          <ClientVersionsStatsContent locale={locale} />
        </Suspense>
      </SettingsSection>
    </div>
  );
}

async function ClientVersionsSettingsContent() {
  const [settingsResult, statsResult] = await Promise.all([
    fetchSystemSettings(),
    fetchClientVersionStats(),
  ]);

  const enableClientVersionCheck = settingsResult.ok
    ? settingsResult.data.enableClientVersionCheck
    : false;
  const clientVersionPinned = settingsResult.ok
    ? (settingsResult.data.clientVersionPinned ?? {})
    : {};

  // 锁定输入框列表 = 最近 7 天活跃的客户端类型 ∪ 已经配过 pinned 值的类型。
  // 后者保证：用户配置过的旧客户端即便最近没流量，也仍然能看到/清掉锁定值。
  const detectedTypes = statsResult.ok ? statsResult.data.map((s) => s.clientType) : [];
  const pinnedKeys = Object.keys(clientVersionPinned);
  const clientTypes = Array.from(new Set([...detectedTypes, ...pinnedKeys]));

  return (
    <ClientVersionToggle
      enabled={enableClientVersionCheck}
      pinned={clientVersionPinned}
      clientTypes={clientTypes}
    />
  );
}

async function ClientVersionsStatsContent({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "settings" });
  const statsResult = await fetchClientVersionStats();
  const stats = statsResult.ok ? statsResult.data : [];

  if (!stats || stats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center rounded-xl bg-white/[0.02] border border-white/5">
        <p className="text-muted-foreground">{t("clientVersions.empty.title")}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("clientVersions.empty.description")}
        </p>
      </div>
    );
  }

  return <ClientVersionStatsTable data={stats} />;
}
