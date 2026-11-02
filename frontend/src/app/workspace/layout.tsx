import "katex/dist/katex.min.css";
import "streamdown/styles.css";

import { AuthProvider } from "@/core/auth/AuthProvider";
import { getServerSideUser } from "@/core/auth/server";
import { I18nProvider } from "@/core/i18n/context";
import { detectLocaleServer } from "@/core/i18n/server";

import { WorkspaceContent } from "./workspace-content";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await detectLocaleServer();
  // Single-user deployment: the server always resolves an authenticated user.
  const result = await getServerSideUser();

  return (
    <I18nProvider initialLocale={locale}>
      <AuthProvider
        initialUser={result.tag === "authenticated" ? result.user : null}
      >
        <WorkspaceContent>{children}</WorkspaceContent>
      </AuthProvider>
    </I18nProvider>
  );
}
