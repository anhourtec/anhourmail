// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { importTargets } from "@anhourmail/core/imports";
import { IMPORT, IMPORT_SOURCE_PRESETS } from "@anhourmail/shared/import";
import { PageHeader } from "@anhourmail/ui/page-header";

import { NewImportForm } from "@/components/imports/new-import-form";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "New import" };

/**
 * New import (ADR-0030 §17): pick the mailbox (own ones, or any for admins), the old provider (a preset or any IMAP
 * server), the sign-in name and an app password from there (write-only), and the options; a recent confirmation that
 * it's the person is asked in place when needed.
 */
export default async function NewImportPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const data = await forPage(() => importTargets(container().deps, actor, accountId));
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const crumbs = [{ label: "Home", href: "/" }, { label: "Import mail", href: base }, { label: "New import" }];
  const site = env().SITE_URL.replace(/\/$/, "");
  return (
    <>
      <PageHeader
        title="New import"
        description="We sign in to your old mailbox with an app password, read it, and copy everything into a mailbox here. Nothing at the old provider is changed or deleted."
        breadcrumbs={crumbs}
      />
      {data === null ? (
        <p className="am-body">Your role in this account doesn&apos;t include importing mail.</p>
      ) : data.targets.length === 0 ? (
        <p className="am-body rounded-lg border px-4 py-3">
          You don&apos;t have a mailbox in this account to import into yet. Ask an owner to create one for you.
        </p>
      ) : (
        <NewImportForm
          accountId={accountId}
          targets={data.targets}
          presets={IMPORT_SOURCE_PRESETS.map((p) => ({ ...p, docsUrl: `${site}/docs/${p.docsSlug}` }))}
          maxMessageMb={IMPORT.maxMessageBytes / 1_000_000}
          syncWindowDays={IMPORT.syncWindowDays}
        />
      )}
    </>
  );
}
