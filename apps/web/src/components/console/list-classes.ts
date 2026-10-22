// SPDX-License-Identifier: AGPL-3.0-only
/** Table classes shared by console lists: hairline rows of ~46 px, muted 13 px headers. */ // A plain module (no "use client") so server components get the real object: importing a value from a client
// module hands a server component a client reference, and every class name came out undefined.
export const listClass = {
  wrap: "-mx-1 overflow-x-auto px-1",
  table: "w-full border-collapse text-left text-[14px]",
  th: "h-10 border-b px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground",
  row: "border-b transition-colors hover:bg-accent/40 data-[open=true]:bg-accent data-[selected=true]:bg-accent/60",
  td: "h-[46px] px-3 py-2 align-middle",
  check: "w-10 pr-0 pl-3",
} as const;
