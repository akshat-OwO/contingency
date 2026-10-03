import { selectableUserAgentProfiles } from "@contingency/protocol";
import type { UserAgentProfileId } from "@contingency/protocol";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Only the identities Chromium can genuinely reproduce are offered for new
 * work: Safari and Firefox profiles could disguise Chromium with a string but
 * never behave as those engines ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
type UserAgentProfile = (typeof selectableUserAgentProfiles)[number];

const userAgentGroups: {
  readonly group: string;
  readonly profiles: UserAgentProfile[];
}[] = [];

for (const profile of selectableUserAgentProfiles) {
  const existingGroup = userAgentGroups.find(
    ({ group }) => group === profile.group
  );
  if (existingGroup === undefined) {
    userAgentGroups.push({ group: profile.group, profiles: [profile] });
  } else {
    existingGroup.profiles.push(profile);
  }
}

/**
 * Every identity the browser can present, grouped by family, as one radio
 * group. It is a list rather than a menu so the inspector card can show the
 * whole choice at once.
 */
export const UserAgentList = ({
  disabled,
  onValueChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onValueChange: (value: UserAgentProfileId) => void;
  readonly value: UserAgentProfileId;
}) => (
  <div aria-label="User agent" className="space-y-2" role="radiogroup">
    {userAgentGroups.map(({ group, profiles }) => (
      <section aria-label={group} key={group}>
        <h3 className="text-muted-foreground px-2 py-1 text-xs font-medium">
          {group}
        </h3>
        {profiles.map((profile) => {
          const selected = profile.id === value;
          return (
            <button
              aria-checked={selected}
              className={cn(
                "hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50",
                selected && "bg-muted font-medium"
              )}
              disabled={disabled}
              key={profile.id}
              onClick={() => {
                if (!selected) {
                  onValueChange(profile.id);
                }
              }}
              role="radio"
              type="button"
            >
              {profile.label}
              {selected ? (
                <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
            </button>
          );
        })}
      </section>
    ))}
  </div>
);
