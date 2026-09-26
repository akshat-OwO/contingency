import type { BrowserBotProtectionBlock } from "@contingency/protocol";
import { ShieldAlertIcon, XIcon } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const PROVIDER_NAMES: Record<BrowserBotProtectionBlock["provider"], string> = {
  cloudflare: "Cloudflare",
};

/** The host a refused request went to, or the whole URL when it has none. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * The site's bot protection refused the session's browser. Without this, a
 * blocked login just resets its form, and the user blames the site or the
 * Flow Skill (#266). Only the latest block shows: one refusal usually brings
 * several requests down with it, and they all say the same thing.
 */
export const BotProtectionNotice = ({
  block,
  onDismiss,
}: {
  readonly block: BrowserBotProtectionBlock;
  readonly onDismiss: () => void;
}) => (
  <Alert variant="destructive">
    <ShieldAlertIcon aria-hidden="true" />
    <AlertTitle>{hostOf(block.url)} blocked this browser</AlertTitle>
    <AlertDescription>
      {PROVIDER_NAMES[block.provider]} bot protection refused a request with
      HTTP {block.status}. The site is turning away automated browsers, so the
      page is not broken and neither is the Flow Skill.
    </AlertDescription>
    <AlertAction>
      <Button
        aria-label="Dismiss bot protection notice"
        onClick={onDismiss}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </AlertAction>
  </Alert>
);
