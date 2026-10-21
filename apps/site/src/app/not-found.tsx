// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="am-site-section am-site-wrap flex flex-1 flex-col items-start gap-4">
      <span className="am-eyebrow">Error 404</span>
      <h1 className="am-site-h2">This page doesn’t exist.</h1>
      <Link href="/" className="am-site-btn am-site-btn--secondary">
        Back to home
      </Link>
    </main>
  );
}
