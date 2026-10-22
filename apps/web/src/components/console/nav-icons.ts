// SPDX-License-Identifier: AGPL-3.0-only
import {
  AtSign,
  Building2,
  CreditCard,
  FileClock,
  Globe,
  Inbox,
  type LucideIcon,
  Mail,
  Receipt,
  ScrollText,
  Shield,
  ShieldAlert,
  UserCog,
  Users,
} from "lucide-react";

import type { NavIcon } from "@/server/console-nav";

/** Lucide component for each navigation icon name in console-nav.ts. */
export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  mail: Mail,
  shield: Shield,
  globe: Globe,
  inbox: Inbox,
  "at-sign": AtSign,
  users: Users,
  "credit-card": CreditCard,
  "scroll-text": ScrollText,
  building: Building2,
  "shield-alert": ShieldAlert,
  receipt: Receipt,
  "file-clock": FileClock,
  "user-cog": UserCog,
};
