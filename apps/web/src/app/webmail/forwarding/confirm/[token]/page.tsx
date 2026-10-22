// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { AuthSplit } from "@/components/auth-split";
import { ForwardingConfirm } from "@/components/webmail/forwarding-confirm";

export const metadata: Metadata = { title: "Confirm forwarding", referrer: "no-referrer" };

/**
 * Where a forwarding confirmation email links (webmail origin, no sign-in needed). Opening the page changes
 * nothing: the button posts the token, so a link scanner following the URL can't confirm.
 */
export default async function ForwardingConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthSplit area="Webmail">
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Confirm forwarding</h1>
        <p className="am-small">
          A mailbox asked to forward its mail to your address. Confirm only if you know and trust it. You can ask its
          owner to stop forwarding at any time.
        </p>
      </div>
      <ForwardingConfirm token={token.slice(0, 64)} />
    </AuthSplit>
  );
}
