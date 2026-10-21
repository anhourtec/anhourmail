// SPDX-License-Identifier: AGPL-3.0-only
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="am-h1">Page not found</h1>
      <p className="am-lead">The page doesn't exist, or you don't have access to it.</p>
      <p className="am-micro am-num">Error 404</p>
    </main>
  );
}
