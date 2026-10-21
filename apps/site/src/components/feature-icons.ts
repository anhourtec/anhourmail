// SPDX-License-Identifier: AGPL-3.0-only
import { EyeOffIcon, GlobeIcon, PlugIcon, VenetianMaskIcon, ZapIcon } from "lucide-react";

import type { FeatureSlug } from "@/lib/ia";

export const FEATURE_ICONS: Record<FeatureSlug, typeof GlobeIcon> = {
  "custom-domains": GlobeIcon,
  aliases: VenetianMaskIcon,
  webmail: ZapIcon,
  privacy: EyeOffIcon,
  apps: PlugIcon,
};
