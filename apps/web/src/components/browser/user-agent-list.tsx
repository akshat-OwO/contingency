import { selectableUserAgentProfiles } from "@contingency/protocol";
import type { UserAgentProfileId } from "@contingency/protocol";
import { CheckIcon } from "lucide-react";

import {
  Listbox,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxItemIndicator,
} from "@/components/ui/listbox";

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

const isSelectable = (value: string): value is UserAgentProfileId =>
  selectableUserAgentProfiles.some(({ id }) => id === value);

/**
 * Every identity the browser can present, grouped by family, as one listbox.
 * Arrows move focus without applying anything — each choice restarts the
 * session's identity, so it is applied only on Enter, Space, or a click.
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
  <Listbox
    activation="manual"
    aria-label="User agent"
    className="space-y-2"
    disabled={disabled}
    // Focus stops at the ends rather than wrapping.
    loop={false}
    onValueChange={(next) => {
      if (next !== null && next !== value && isSelectable(next)) {
        onValueChange(next);
      }
    }}
    // A legacy identity is not offered, so nothing is chosen and the first
    // option keeps the tab stop.
    value={isSelectable(value) ? value : null}
  >
    {userAgentGroups.map(({ group, profiles }) => (
      <ListboxGroup key={group}>
        <ListboxGroupLabel>{group}</ListboxGroupLabel>
        {profiles.map((profile) => (
          <ListboxItem
            className="hover:bg-muted focus-visible:ring-ring data-selected:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:ring-2 data-selected:font-medium"
            key={profile.id}
            value={profile.id}
          >
            {profile.label}
            <ListboxItemIndicator>
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </ListboxItemIndicator>
          </ListboxItem>
        ))}
      </ListboxGroup>
    ))}
  </Listbox>
);
